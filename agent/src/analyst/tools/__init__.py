"""Typed agent tools backed by the rankings dataset.

Each tool is exposed via LangChain's ``@tool`` decorator so it can be bound
to a chat model with ``model.bind_tools(...)``. Add new tools here and
register them in ``TOOLS`` so the planner discovers them automatically.
"""

from analyst.tools.analyze_career_arc import analyze_career_arc
from analyst.tools.build_xi import build_xi
from analyst.tools.compare_players import compare_players
from analyst.tools.get_player import get_player
from analyst.tools.query_players import query_players

TOOLS = [query_players, get_player, compare_players, build_xi, analyze_career_arc]

__all__ = [
    "TOOLS",
    "analyze_career_arc",
    "build_xi",
    "compare_players",
    "get_player",
    "query_players",
]
