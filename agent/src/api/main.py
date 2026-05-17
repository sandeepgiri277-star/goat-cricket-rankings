"""FastAPI server in front of the analyst graph.

Endpoints:
  GET  /healthz                    — liveness
  POST /ask                        — single-shot synchronous question
  POST /ask/stream                 — SSE stream: yields plan / tool / final events
  POST /ask/approve                — resume a paused HITL session

Auth: relies on the upstream Cloudflare Worker for origin lock + rate limit;
this service is intended to be private behind the worker. If exposed
publicly, layer in a per-request API token.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import BaseModel

from analyst.graph import build_graph
from analyst.state import AnalystState
from analyst.tracing import get_trace_url, trace_enabled


# A single in-memory checkpointer is fine for one process; for multi-replica
# deploys we'd swap to redis/postgres-backed checkpointing.
_checkpointer = MemorySaver()
_graph = build_graph(checkpointer=_checkpointer)

app = FastAPI(title="GOAT Cricket Analyst", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict via the worker; keep this open for dev
    allow_methods=["*"],
    allow_headers=["*"],
)


class AskRequest(BaseModel):
    question: str
    require_approval: bool = False
    session_id: str | None = None


class ApprovalRequest(BaseModel):
    session_id: str
    approved: bool


def _final_payload(result: dict[str, Any]) -> dict[str, Any]:
    final = result.get("final")
    plan = result.get("plan")
    critique = result.get("critique")
    return {
        "ok": True,
        "final": final.model_dump() if final else None,
        "plan": plan.model_dump() if plan else None,
        "critique": critique.model_dump() if critique else None,
        "revision_count": result.get("revision_count", 0),
        "tool_iterations": result.get("tool_iterations", 0),
        "trace_url": get_trace_url() if trace_enabled() else None,
    }


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"ok": True, "tracing": trace_enabled()}


@app.post("/ask")
def ask(req: AskRequest) -> dict[str, Any]:
    """One-shot. If ``require_approval`` is true and the plan has >1 sub-task,
    the graph pauses and returns a session_id; resume via ``/ask/approve``."""
    if not req.question.strip():
        raise HTTPException(400, "question must be non-empty")

    session_id = req.session_id or uuid.uuid4().hex
    config = {"configurable": {"thread_id": session_id}}
    initial = AnalystState(question=req.question, require_approval=req.require_approval)

    result = _graph.invoke(initial, config=config)

    snapshot = _graph.get_state(config)
    if snapshot.next:  # graph is paused at an interrupt
        interrupts = snapshot.tasks[0].interrupts if snapshot.tasks else []
        return {
            "ok": True,
            "status": "awaiting_approval",
            "session_id": session_id,
            "interrupt": interrupts[0].value if interrupts else None,
            "trace_url": get_trace_url() if trace_enabled() else None,
        }

    payload = _final_payload(result)
    payload["session_id"] = session_id
    return payload


@app.post("/ask/approve")
def approve(req: ApprovalRequest) -> dict[str, Any]:
    config = {"configurable": {"thread_id": req.session_id}}
    result = _graph.invoke(Command(resume={"approved": req.approved}), config=config)
    payload = _final_payload(result)
    payload["session_id"] = req.session_id
    return payload


async def _event_stream(question: str, session_id: str) -> AsyncIterator[bytes]:
    """SSE stream of structured events from the graph."""
    config = {"configurable": {"thread_id": session_id}}
    initial = AnalystState(question=question)

    def _ev(kind: str, data: dict | None = None) -> bytes:
        body = {"kind": kind, **(data or {})}
        return f"data: {json.dumps(body, default=str)}\n\n".encode()

    yield _ev("session", {"session_id": session_id})

    async for chunk in _graph.astream(initial, config=config, stream_mode="updates"):
        for node_name, node_update in chunk.items():
            if node_name == "planner" and "plan" in node_update:
                yield _ev("plan", {"plan": node_update["plan"].model_dump()})
            elif node_name == "retriever":
                yield _ev("retrieved", {"context": node_update.get("retrieved_context") or ""})
            elif node_name == "tool_executor":
                tool_calls: list[dict] = []
                for m in node_update.get("messages", []):
                    role = getattr(m, "type", "")
                    if role == "tool":
                        tool_calls.append({"tool": getattr(m, "name", "?"), "result_preview": str(m.content)[:300]})
                    elif role == "ai" and getattr(m, "tool_calls", None):
                        for call in m.tool_calls:
                            tool_calls.append({"tool": call["name"], "args": call.get("args")})
                if tool_calls:
                    yield _ev("tool_step", {"calls": tool_calls})
            elif node_name == "synthesizer" and "draft" in node_update:
                yield _ev("draft", {"draft": node_update["draft"].model_dump()})
            elif node_name == "critic":
                if node_update.get("critique"):
                    yield _ev("critique", {"critique": node_update["critique"].model_dump()})
                if node_update.get("final"):
                    yield _ev("final", {"final": node_update["final"].model_dump()})

    if trace_enabled():
        url = get_trace_url()
        if url:
            yield _ev("trace_url", {"url": url})
    yield _ev("end")


@app.post("/ask/stream")
def ask_stream(req: AskRequest) -> StreamingResponse:
    if not req.question.strip():
        raise HTTPException(400, "question must be non-empty")
    session_id = req.session_id or uuid.uuid4().hex
    return StreamingResponse(
        _event_stream(req.question, session_id),
        media_type="text/event-stream",
    )
