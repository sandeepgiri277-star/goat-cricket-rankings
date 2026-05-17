"""Side-by-side comparison of two players in the same format."""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import Field

from analyst.tools._data import find_player


def _delta(a: float | int | None, b: float | int | None) -> float | None:
    if a is None or b is None:
        return None
    return round(a - b, 2)


@tool
def compare_players(
    player_a: str = Field(description="First player's name (partial match allowed)."),
    player_b: str = Field(description="Second player's name (partial match allowed)."),
    format: Literal["tests", "odis", "t20is", "ipl"] = Field(
        description="Cricket format both players are evaluated in."
    ),
) -> dict:
    """Compare two players head-to-head: ratings, ranks, career averages,
    longevity (matches played). Useful when a question is framed as
    'X vs Y' or 'is X better than Y'.

    Returns deltas where ``a - b`` is positive when player_a leads.
    Returns ``error`` field if either player isn't found.
    """
    a = find_player(format, player_a)
    b = find_player(format, player_b)
    if a is None or b is None:
        return {
            "error": "player_not_found",
            "missing": [n for n, p in [(player_a, a), (player_b, b)] if p is None],
        }
    return {
        "player_a": {
            "name": a["name"],
            "country": a["country"],
            "matches": a["matches"],
            "bat_rating": a.get("bat_rating"),
            "bowl_rating": a.get("bowl_rating"),
            "ar_rating": a.get("ar_rating"),
            "career_bat_avg": a.get("career_bat_avg"),
            "career_bowl_avg": a.get("career_bowl_avg"),
            "career_bowl_sr": a.get("career_bowl_sr"),
        },
        "player_b": {
            "name": b["name"],
            "country": b["country"],
            "matches": b["matches"],
            "bat_rating": b.get("bat_rating"),
            "bowl_rating": b.get("bowl_rating"),
            "ar_rating": b.get("ar_rating"),
            "career_bat_avg": b.get("career_bat_avg"),
            "career_bowl_avg": b.get("career_bowl_avg"),
            "career_bowl_sr": b.get("career_bowl_sr"),
        },
        "deltas": {
            "bat_rating": _delta(a.get("bat_rating"), b.get("bat_rating")),
            "bowl_rating": _delta(a.get("bowl_rating"), b.get("bowl_rating")),
            "ar_rating": _delta(a.get("ar_rating"), b.get("ar_rating")),
            "career_bat_avg": _delta(a.get("career_bat_avg"), b.get("career_bat_avg")),
            "career_bowl_avg": _delta(a.get("career_bowl_avg"), b.get("career_bowl_avg")),
        },
    }
