"""Return the top-N players in a format for a given discipline."""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import Field

from analyst.tools._data import get_all_players


@tool
def query_players(
    format: Literal["tests", "odis", "t20is", "ipl"] = Field(
        description="Cricket format to query."
    ),
    discipline: Literal["batting", "bowling", "allrounder"] = Field(
        description="Which leaderboard to pull from."
    ),
    top_n: int = Field(
        default=10, ge=1, le=50, description="How many players to return (max 50)."
    ),
    country: str | None = Field(
        default=None,
        description="Optional ISO-ish country code or substring to filter by (e.g. 'IND', 'AUS').",
    ),
    min_matches: int | None = Field(
        default=None, description="Optional minimum matches played."
    ),
) -> list[dict]:
    """Return the top-N players from the requested format/discipline leaderboard.

    Each item includes name, country, rating, rank, matches, and the key career
    averages so the model has enough to ground its analysis without further
    lookups.
    """
    players = get_all_players(format)

    rating_key, rank_key = {
        "batting": ("bat_rating", "bat_rank"),
        "bowling": ("bowl_rating", "bowl_rank"),
        "allrounder": ("ar_rating", "ar_rank"),
    }[discipline]

    filtered = [p for p in players if p.get(rating_key, 0) > 0]
    if country:
        c = country.lower()
        filtered = [p for p in filtered if c in p.get("country", "").lower()]
    if min_matches is not None:
        filtered = [p for p in filtered if p.get("matches", 0) >= min_matches]

    filtered.sort(key=lambda p: p.get(rank_key) or 10**9)
    out = []
    for p in filtered[:top_n]:
        out.append(
            {
                "name": p["name"],
                "country": p["country"],
                "matches": p["matches"],
                "rating": p.get(rating_key),
                "rank": p.get(rank_key),
                "career_bat_avg": p.get("career_bat_avg"),
                "career_bowl_avg": p.get("career_bowl_avg"),
                "career_bowl_sr": p.get("career_bowl_sr"),
                "playing_role": p.get("playing_role"),
                "bowl_type": p.get("bowl_type"),
            }
        )
    return out
