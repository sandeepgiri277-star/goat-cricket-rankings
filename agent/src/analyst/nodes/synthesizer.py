"""Synthesizer node: writes the structured draft answer.

On the first pass this is just "compose an answer from research log".
On a revision pass (when state.critique is set), the prompt incorporates the
critic's issues and suggested follow-ups so the regen targets specific gaps.
"""

from __future__ import annotations

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from analyst.config import settings
from analyst.state import AnalystState, FinalAnswer
from analyst.tracing import observe

SYSTEM_PROMPT = """You are the GOAT Cricket Analyst's final writer.
Given the question and the research conversation, produce a structured answer.

Rules:
- Be concise: 2-5 sentences in `summary`.
- Cite specific numbers (ratings, averages, ranks) from the research log.
- `key_points` should be 2-4 short bullets, each a single substantive claim.
- `cited_players` lists every player you reference by name.
- Never invent stats. If the research log lacks a number, acknowledge the
  gap instead of guessing."""


@observe(name="synthesizer")
def synthesizer_node(state: AnalystState) -> dict:
    cfg = settings()
    llm = ChatAnthropic(
        model=cfg["model"],
        api_key=cfg["anthropic_api_key"],
        temperature=0,
    ).with_structured_output(FinalAnswer)

    research_log = "\n".join(
        f"{m.type.upper()}: {m.content}" for m in state.messages if m.content
    )[:8000]

    parts = [f"User question: {state.question}"]
    if state.retrieved_context:
        parts.append(f"Retrieved context:\n{state.retrieved_context}")
    parts.append(f"Research log:\n{research_log}")

    if state.critique and not state.critique.passed and state.draft:
        parts.append(
            "Previous draft FAILED critique. Address these issues precisely:\n"
            + "\n".join(f"- {i}" for i in state.critique.issues)
            + (
                "\nFollow-ups suggested:\n"
                + "\n".join(f"- {f}" for f in state.critique.suggested_followups)
                if state.critique.suggested_followups
                else ""
            )
            + f"\n\nPrevious draft summary: {state.draft.summary}"
        )

    draft: FinalAnswer = llm.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content="\n\n".join(parts)),
        ]
    )
    return {"draft": draft}
