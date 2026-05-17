"""Retrieval layer for the analyst.

Why this exists: pulling the *whole* 870-player dataset into every LLM call
is wasteful and noisy. Retrieval narrows the context to the few player
profiles most relevant to the user's question, so the planner and
tool_executor start with a shortlist instead of having to guess names.

This module presents a tiny pluggable interface (``Retriever``) with two
implementations:

  - ``BM25Retriever`` — lexical, zero external deps, default. Good enough
    for proper-noun-heavy queries like "Imran Khan" or "Pakistan fast bowlers".
  - ``SemanticRetriever`` — placeholder slot for when you wire Voyage /
    OpenAI / sentence-transformers later. The interview talking point is
    "I started lexical and benchmarked semantic before paying for it."

The interface returns ``RetrievalHit`` objects so the call sites stay
implementation-agnostic.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

import numpy as np
from rank_bm25 import BM25Okapi

from analyst.tools._data import get_all_players


@dataclass
class RetrievalHit:
    name: str
    country: str
    score: float
    snippet: str


def _player_doc(p: dict) -> str:
    """Flatten a player into a search-friendly text doc."""
    parts = [
        p["name"],
        p.get("country", ""),
        str(p.get("playing_role") or ""),
        str(p.get("bowl_type") or ""),
        f"matches {p.get('matches')}",
        f"bat avg {p.get('career_bat_avg')}",
        f"bowl avg {p.get('career_bowl_avg')}",
    ]
    return " ".join(filter(None, parts)).lower()


class Retriever(Protocol):
    def search(self, query: str, k: int = 5) -> list[RetrievalHit]: ...


class BM25Retriever:
    """Lexical retrieval over flattened player profiles."""

    def __init__(self, fmt: str) -> None:
        self.fmt = fmt
        self.players = get_all_players(fmt)
        docs = [_player_doc(p) for p in self.players]
        self.bm25 = BM25Okapi([d.split() for d in docs])

    def search(self, query: str, k: int = 5) -> list[RetrievalHit]:
        toks = query.lower().split()
        if not toks:
            return []
        scores = self.bm25.get_scores(toks)
        idx = np.argsort(scores)[::-1][:k]
        hits: list[RetrievalHit] = []
        for i in idx:
            if scores[i] <= 0:
                continue
            p = self.players[i]
            snippet = (
                f"{p['name']} ({p['country']}), {p.get('matches')} matches, "
                f"bat {p.get('bat_rating')}/{p.get('bat_rank')}, "
                f"bowl {p.get('bowl_rating')}/{p.get('bowl_rank')}"
            )
            hits.append(
                RetrievalHit(
                    name=p["name"],
                    country=p.get("country", ""),
                    score=float(scores[i]),
                    snippet=snippet,
                )
            )
        return hits


@lru_cache(maxsize=4)
def get_retriever(fmt: str) -> Retriever:
    return BM25Retriever(fmt)


def format_hits(hits: list[RetrievalHit]) -> str:
    if not hits:
        return ""
    return "Potentially relevant players:\n" + "\n".join(
        f"- {h.snippet} (score={h.score:.2f})" for h in hits
    )
