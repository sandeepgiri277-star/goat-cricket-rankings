"""Retrieval node: narrows player context before the tool_executor runs."""

from __future__ import annotations

from analyst.retrieval import format_hits, get_retriever
from analyst.state import AnalystState
from analyst.tracing import observe


@observe(name="retriever")
def retriever_node(state: AnalystState) -> dict:
    if state.plan is None:
        return {}
    retriever = get_retriever(state.plan.format)
    hits = retriever.search(state.question, k=8)
    return {"retrieved_context": format_hits(hits)}
