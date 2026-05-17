"""Planner node: parses the user question into a structured Plan.

Uses Anthropic's structured-output mode via LangChain's ``with_structured_output``
so we get a validated ``Plan`` object instead of free-form text. This is the
single biggest reliability win in agentic systems — never parse JSON by hand.
"""

from __future__ import annotations

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from analyst.config import settings
from analyst.state import AnalystState, Plan
from analyst.tracing import observe

SYSTEM_PROMPT = """You are the planner for the GOAT Cricket Analyst.
Given a user question, decide:
  - which cricket format the question is about (tests, odis, t20is, ipl)
  - a brief rationale for the format choice
  - 2 to 5 atomic sub-tasks the agent should take, each phrased as an
    imperative ("Fetch top 10 Test bowlers by rating", "Look up Imran Khan's
    full Test profile", "Compare X and Y in ODIs", ...)

Sub-tasks should map cleanly to available tools:
  - query_players(format, discipline, top_n, country?, min_matches?)
  - get_player(name, format)
  - compare_players(player_a, player_b, format)

If the format isn't clear from context, default to 'tests'."""


@observe(name="planner")
def planner_node(state: AnalystState) -> dict:
    cfg = settings()
    llm = ChatAnthropic(
        model=cfg["model"],
        api_key=cfg["anthropic_api_key"],
        temperature=0,
    ).with_structured_output(Plan)

    plan: Plan = llm.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=state.question),
        ]
    )
    return {"plan": plan}
