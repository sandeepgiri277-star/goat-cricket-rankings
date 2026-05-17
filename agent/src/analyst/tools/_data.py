"""Lazy loader for the rankings JSON shipped on docs/."""

from __future__ import annotations

import json
from functools import lru_cache

from analyst.config import FORMAT_FILES

Format = str  # "tests" | "odis" | "t20is" | "ipl"


@lru_cache(maxsize=4)
def load_format(fmt: Format) -> dict:
    if fmt not in FORMAT_FILES:
        raise ValueError(f"Unknown format {fmt!r}. Choose from {list(FORMAT_FILES)}.")
    path = FORMAT_FILES[fmt]
    if not path.exists():
        raise FileNotFoundError(f"Missing rankings file: {path}")
    with path.open() as f:
        return json.load(f)


def get_all_players(fmt: Format) -> list[dict]:
    return load_format(fmt).get("all_players", [])


def find_player(fmt: Format, name: str) -> dict | None:
    needle = name.strip().lower()
    for p in get_all_players(fmt):
        if p["name"].lower() == needle:
            return p
    for p in get_all_players(fmt):
        if needle in p["name"].lower():
            return p
    return None
