"""Pick a constraint-satisfying XI from the rankings.

The frontend has elaborate min-role constraints; we mirror them here.
Allrounders count toward both their bat/bowl-position bucket AND the
allrounder bucket. The selector is greedy on rating with backfill to
satisfy minimums — fast and good-enough for an agent tool.
"""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import Field

from analyst.tools._data import get_all_players

ROLE_TEMPLATES = {
    "tests": {"openers": 2, "middle": 3, "allrounders": 1, "keeper": 1, "fast": 2, "spinner": 1},
    "odis": {"openers": 2, "middle": 3, "allrounders": 1, "keeper": 1, "fast": 2, "spinner": 1},
    "t20is": {"openers": 2, "middle": 3, "allrounders": 1, "keeper": 1, "fast": 2, "spinner": 1},
    "ipl": {"openers": 2, "middle": 3, "allrounders": 1, "keeper": 1, "fast": 2, "spinner": 1},
}


def _player_roles(p: dict) -> set[str]:
    """Compute which buckets a player counts toward."""
    roles = set()
    bat = p.get("bat_rating") or 0
    bowl = p.get("bowl_rating") or 0
    playing = (p.get("playing_role") or "").lower()
    bowl_type = (p.get("bowl_type") or "").lower()

    is_keeper = "keeper" in playing or "wicketkeeper" in playing
    is_ar = bat >= 500 and bowl >= 500

    if is_keeper:
        roles.add("keeper")
    if is_ar:
        roles.add("allrounders")

    if bat >= bowl:
        if "opener" in playing:
            roles.add("openers")
        else:
            roles.add("middle")

    if bowl >= 400:
        if "spin" in bowl_type or "spin" in playing:
            roles.add("spinner")
        elif "fast" in bowl_type or "pace" in playing or "medium" in bowl_type:
            roles.add("fast")
        else:
            roles.add("fast")  # default bucket

    return roles


@tool
def build_xi(
    format: Literal["tests", "odis", "t20is", "ipl"] = Field(
        description="Cricket format to assemble the XI for."
    ),
    country: str | None = Field(
        default=None,
        description="Optional country filter (e.g. 'IND' for India-only XI).",
    ),
    era_min_match: int | None = Field(
        default=None,
        description="Optional: only include players with rank.matches >= this (rough era proxy).",
    ),
    era_max_match: int | None = Field(
        default=None,
        description="Optional: cap on matches (use to exclude long-format greats from short-format hypotheticals).",
    ),
    exclude: list[str] | None = Field(
        default=None, description="Player names to exclude from selection."
    ),
) -> dict:
    """Greedily assemble an 11-player XI from the rankings that satisfies the
    standard role minimums (2 openers, 3 middle order, 1 keeper, 1 allrounder,
    2 fast bowlers, 1 spinner — allrounders count toward two buckets).

    Returns the XI, a per-player rationale, and any unmet constraints. Useful
    for "build me a 90s XI" or "best South African Test XI" style questions.
    """
    players = sorted(
        [p for p in get_all_players(format) if (p.get("bat_rating") or 0) + (p.get("bowl_rating") or 0) > 0],
        key=lambda p: -((p.get("bat_rating") or 0) + (p.get("bowl_rating") or 0)),
    )

    excl = {e.lower() for e in (exclude or [])}
    template = dict(ROLE_TEMPLATES[format])
    selected: list[dict] = []
    bucket_counts: dict[str, int] = {k: 0 for k in template}

    def _slot_available(roles: set[str]) -> bool:
        return any(bucket_counts[r] < template[r] for r in roles if r in template)

    for p in players:
        if len(selected) == 11:
            break
        if p["name"].lower() in excl:
            continue
        if country and country.lower() not in p.get("country", "").lower():
            continue
        if era_min_match is not None and p.get("matches", 0) < era_min_match:
            continue
        if era_max_match is not None and p.get("matches", 0) > era_max_match:
            continue
        roles = _player_roles(p)
        if not roles:
            continue
        if _slot_available(roles) or len(selected) < 11:
            selected.append(
                {
                    "name": p["name"],
                    "country": p["country"],
                    "roles": sorted(roles),
                    "bat_rating": p.get("bat_rating"),
                    "bowl_rating": p.get("bowl_rating"),
                    "matches": p["matches"],
                }
            )
            for r in roles:
                if r in template:
                    bucket_counts[r] += 1

    unmet = {k: template[k] - bucket_counts[k] for k in template if bucket_counts[k] < template[k]}
    total_firepower = sum((s["bat_rating"] or 0) + (s["bowl_rating"] or 0) for s in selected)

    return {
        "xi": selected,
        "bucket_counts": bucket_counts,
        "unmet_minimums": unmet,
        "total_firepower": total_firepower,
        "selected_count": len(selected),
    }
