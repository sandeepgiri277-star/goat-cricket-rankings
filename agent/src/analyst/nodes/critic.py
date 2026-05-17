"""Critic node: evaluates the draft for grounding, intent fit, and structure.

A second LLM looks at the original question, the research log, and the draft
answer, and decides whether to ship it or bounce it back for revision. The
critic returns a structured ``Critique`` so the synthesizer's next pass can
target specific issues instead of regenerating blindly.
"""

from __future__ import annotations

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from analyst.config import settings
from analyst.state import AnalystState, Critique
from analyst.tracing import observe

SYSTEM_PROMPT = """You are the GOAT Cricket Analyst's critic.
You evaluate a draft answer against three criteria:

1. GROUNDED — every number, ranking, average, and rating in the summary or
   key_points must be backed by something visible in the research log.
   Vague qualitative claims are allowed; specific numbers must be cited.
2. ADDRESSES_QUESTION — the answer actually responds to what was asked.
   Tangential answers fail this check.
3. STRUCTURE_OK — summary is 2-5 sentences, key_points are 2-4 substantive
   bullets, cited_players matches the people actually discussed.

Return a Critique. Be strict: if any number lacks support, mark grounded=false
and list it. If the answer drifts off-topic, mark addresses_question=false.
Be generous with structure_ok unless something is obviously wrong (e.g. empty
summary, 12 key_points, citations of players not mentioned).

If issues exist, populate suggested_followups with concrete actions the
synthesizer should take on the next pass (e.g. "look up X's career average",
"remove unsupported claim about Y's pitch factor")."""


@observe(name="critic")
def critic_node(state: AnalystState) -> dict:
    cfg = settings()
    llm = ChatAnthropic(
        model=cfg["model"],
        api_key=cfg["anthropic_api_key"],
        temperature=0,
    ).with_structured_output(Critique)

    research_log = "\n".join(
        f"{m.type.upper()}: {m.content}" for m in state.messages if m.content
    )[:8000]

    draft = state.draft
    draft_text = (
        f"summary: {draft.summary}\n"
        f"key_points: {draft.key_points}\n"
        f"cited_players: {draft.cited_players}"
        if draft
        else "(no draft)"
    )

    critique: Critique = llm.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(
                content=(
                    f"User question: {state.question}\n\n"
                    f"Research log:\n{research_log}\n\n"
                    f"Draft answer:\n{draft_text}"
                )
            ),
        ]
    )

    if critique.passed or state.revision_count >= state.max_revisions:
        return {"critique": critique, "final": state.draft}

    return {"critique": critique, "revision_count": state.revision_count + 1}


def critic_branch(state: AnalystState) -> str:
    """Route to END if passed or out of retries, otherwise back to synthesizer."""
    if state.final is not None:
        return "done"
    return "revise"
