"""BM25 retrieval sanity checks."""

from __future__ import annotations

from analyst.retrieval import format_hits, get_retriever


def test_bm25_finds_named_player():
    r = get_retriever("tests")
    hits = r.search("tendulkar", k=3)
    assert any("Tendulkar" in h.name for h in hits)


def test_bm25_finds_by_country():
    r = get_retriever("tests")
    hits = r.search("AUS fast bowler", k=10)
    assert any("AUS" in h.country for h in hits)


def test_format_hits_renders():
    r = get_retriever("tests")
    hits = r.search("imran", k=2)
    rendered = format_hits(hits)
    assert "Imran" in rendered or rendered == ""
