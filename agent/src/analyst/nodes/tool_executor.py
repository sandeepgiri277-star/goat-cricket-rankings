"""Tool-executor node: lets the LLM call tools to satisfy the plan.

This is a classic ReAct-style step: the model decides which tool(s) to call,
LangGraph executes them, results come back as ToolMessages, and the model
either calls more tools or signals it is done. We cap iterations to keep
costs bounded — a critic loop in week 2 will replace this hard cap with
quality-based termination.
"""

from __future__ import annotations

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from analyst.config import settings
from analyst.state import AnalystState
from analyst.tools import TOOLS
from analyst.tracing import observe

SYSTEM_PROMPT = """You are the GOAT Cricket Analyst's research engine.
You have access to typed tools that query a curated dataset of player ratings
and career stats for Tests, ODIs, T20Is and IPL.

Rules:
- Always ground claims in tool outputs. Never invent numbers.
- Use the smallest set of tool calls needed to answer the user's question.
- Stop calling tools as soon as you have enough information to answer.
- When you are done with research, reply with a short factual recap
  (no markdown headings, no advice yet) — the synthesizer node will format
  the final answer."""


@observe(name="tool_executor")
def tool_executor_node(state: AnalystState) -> dict:
    cfg = settings()
    llm = ChatAnthropic(
        model=cfg["model"],
        api_key=cfg["anthropic_api_key"],
        temperature=0,
    ).bind_tools(TOOLS)

    plan_text = ""
    if state.plan:
        plan_text = (
            f"Plan rationale: {state.plan.rationale}\n"
            f"Format: {state.plan.format}\n"
            f"Sub-tasks:\n" + "\n".join(f"- {t}" for t in state.plan.sub_tasks)
        )

    user_parts = [f"User question: {state.question}"]
    if state.retrieved_context:
        user_parts.append(state.retrieved_context)
    if plan_text:
        user_parts.append(plan_text)

    messages: list = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content="\n\n".join(user_parts)),
        *state.messages,
    ]

    ai: AIMessage = llm.invoke(messages)
    new_messages: list = [ai]

    if ai.tool_calls:
        tool_map = {t.name: t for t in TOOLS}
        for call in ai.tool_calls:
            tool = tool_map.get(call["name"])
            if tool is None:
                new_messages.append(
                    ToolMessage(content=f"unknown tool {call['name']}", tool_call_id=call["id"])
                )
                continue
            try:
                result = tool.invoke(call["args"])
            except Exception as e:
                result = {"error": str(e)}
            new_messages.append(
                ToolMessage(content=str(result), tool_call_id=call["id"], name=call["name"])
            )

    return {
        "messages": new_messages,
        "tool_iterations": state.tool_iterations + 1,
    }


def should_continue(state: AnalystState) -> str:
    """Loop while the model is still requesting tools; cap by iteration."""
    if state.tool_iterations >= state.max_tool_iterations:
        return "synthesize"
    last = state.messages[-1] if state.messages else None
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tools"
    return "synthesize"
