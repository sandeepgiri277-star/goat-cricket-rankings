"""Summarise a player's per-10-match stint arc.

Extracts peak window, decline rate, longevity, and consistency from the
``stints`` array each player carries. Saves the LLM from having to reason
over raw stint dicts and gives the synthesizer concrete numbers to cite.
"""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import Field

from analyst.tools._data import find_player


def _safe_mean(xs: list[float | int | None]) -> float | None:
    vals = [x for x in xs if x is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


@tool
def analyze_career_arc(
    name: str = Field(description="Player name; partial matches allowed."),
    format: Literal["tests", "odis", "t20is", "ipl"] = Field(
        description="Cricket format to analyse."
    ),
) -> dict:
    """Compute peak-window, longevity, and decline metrics from a player's
    per-10-match stints in the chosen format.

    Returns:
      - longevity_stints: number of 10-match blocks
      - peak_bat_stint / peak_bat_avg: highest-avg 10-match window (batting)
      - peak_bowl_stint / peak_bowl_avg: lowest-avg 10-match window (bowling)
      - prime_window_bat_avg: avg over the player's middle 50% of stints
      - decline_slope: late-career vs prime delta (negative = declined)
      - notes: short qualitative flags ("late-bloomer", "early peak", etc.)
    """
    p = find_player(format, name)
    if p is None:
        return {"error": "player_not_found", "name": name}

    stints = p.get("stints") or []
    if not stints:
        return {"error": "no_stints", "name": p["name"]}

    bat = [(s["label"], s.get("bat_avg")) for s in stints]
    bowl = [(s["label"], s.get("bowl_avg")) for s in stints]

    bat_vals = [(lab, v) for lab, v in bat if v is not None]
    bowl_vals = [(lab, v) for lab, v in bowl if v is not None]

    peak_bat = max(bat_vals, key=lambda x: x[1]) if bat_vals else (None, None)
    peak_bowl = min(bowl_vals, key=lambda x: x[1]) if bowl_vals else (None, None)

    # prime = middle 50%
    n = len(stints)
    start, end = n // 4, max(n // 4 + 1, (3 * n) // 4)
    prime_slice = stints[start:end]
    prime_bat = _safe_mean([s.get("bat_avg") for s in prime_slice])
    prime_bowl = _safe_mean([s.get("bowl_avg") for s in prime_slice])

    # decline = last quartile vs prime
    late_slice = stints[(3 * n) // 4 :]
    late_bat = _safe_mean([s.get("bat_avg") for s in late_slice])
    late_bowl = _safe_mean([s.get("bowl_avg") for s in late_slice])

    decline_bat = round(late_bat - prime_bat, 2) if late_bat and prime_bat else None
    decline_bowl = round(late_bowl - prime_bowl, 2) if late_bowl and prime_bowl else None

    notes = []
    if n >= 8:
        notes.append("long career")
    elif n <= 3:
        notes.append("short career")
    if peak_bat[1] and prime_bat and peak_bat[1] > prime_bat * 1.3:
        notes.append("sharp peak")
    if decline_bat is not None and decline_bat < -8:
        notes.append("late-career batting decline")
    if decline_bowl is not None and decline_bowl > 5:
        notes.append("late-career bowling decline")

    return {
        "name": p["name"],
        "matches": p["matches"],
        "longevity_stints": n,
        "peak_bat_stint": peak_bat[0],
        "peak_bat_avg": peak_bat[1],
        "peak_bowl_stint": peak_bowl[0],
        "peak_bowl_avg": peak_bowl[1],
        "prime_window_bat_avg": prime_bat,
        "prime_window_bowl_avg": prime_bowl,
        "late_career_bat_avg": late_bat,
        "late_career_bowl_avg": late_bowl,
        "decline_bat_avg_delta": decline_bat,
        "decline_bowl_avg_delta": decline_bowl,
        "notes": notes,
    }
