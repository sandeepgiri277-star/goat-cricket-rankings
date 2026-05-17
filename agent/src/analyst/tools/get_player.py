"""Full per-player profile including stint-level career arc."""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import Field

from analyst.tools._data import find_player


@tool
def get_player(
    name: str = Field(description="Player name; partial matches allowed (e.g. 'Tendulkar')."),
    format: Literal["tests", "odis", "t20is", "ipl"] = Field(
        description="Cricket format to look up."
    ),
) -> dict | None:
    """Return the full profile for a single player: ratings, ranks, career
    averages, and the per-10-match stint arc (used to assess longevity,
    peak windows, decline phases).

    Returns ``None`` if no matching player is found in that format.
    """
    p = find_player(format, name)
    if p is None:
        return None
    return {
        "name": p["name"],
        "country": p["country"],
        "matches": p["matches"],
        "bat_rating": p.get("bat_rating"),
        "bowl_rating": p.get("bowl_rating"),
        "ar_rating": p.get("ar_rating"),
        "bat_rank": p.get("bat_rank"),
        "bowl_rank": p.get("bowl_rank"),
        "ar_rank": p.get("ar_rank"),
        "career_bat_avg": p.get("career_bat_avg"),
        "career_bowl_avg": p.get("career_bowl_avg"),
        "career_bowl_sr": p.get("career_bowl_sr"),
        "career_rpi": p.get("career_rpi"),
        "career_wpi": p.get("career_wpi"),
        "bat_inns": p.get("bat_inns"),
        "bowl_inns": p.get("bowl_inns"),
        "playing_role": p.get("playing_role"),
        "bowl_type": p.get("bowl_type"),
        "bat_pitch_factor": p.get("bat_pitch_factor"),
        "bowl_pitch_factor": p.get("bowl_pitch_factor"),
        "stints": p.get("stints", []),
    }
