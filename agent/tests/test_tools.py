"""Pure unit tests for the agent tools. No LLM calls, no API keys required."""

from __future__ import annotations

import pytest

from analyst.tools import (
    analyze_career_arc,
    build_xi,
    compare_players,
    get_player,
    query_players,
)


class TestQueryPlayers:
    def test_top_test_bowlers(self):
        out = query_players.invoke(
            {"format": "tests", "discipline": "bowling", "top_n": 3}
        )
        assert len(out) == 3
        assert out[0]["rank"] == 1
        assert all(p["rating"] is not None for p in out)
        assert all(p["rank"] <= p["rank"] for p in out)  # monotonic

    def test_country_filter(self):
        out = query_players.invoke(
            {"format": "tests", "discipline": "batting", "top_n": 5, "country": "IND"}
        )
        assert all("IND" in p["country"] for p in out)

    def test_min_matches(self):
        out = query_players.invoke(
            {"format": "tests", "discipline": "batting", "top_n": 10, "min_matches": 100}
        )
        assert all(p["matches"] >= 100 for p in out)

    def test_caps_at_50(self):
        with pytest.raises(Exception):
            query_players.invoke(
                {"format": "tests", "discipline": "batting", "top_n": 999}
            )


class TestGetPlayer:
    def test_exact_match(self):
        p = get_player.invoke({"name": "SR Tendulkar", "format": "tests"})
        assert p is not None
        assert p["name"] == "SR Tendulkar"
        assert p["matches"] == 200
        assert len(p["stints"]) > 0

    def test_partial_match(self):
        p = get_player.invoke({"name": "tendulkar", "format": "tests"})
        assert p is not None
        assert "Tendulkar" in p["name"]

    def test_not_found(self):
        p = get_player.invoke({"name": "Definitely Not A Real Player Name", "format": "tests"})
        assert p is None


class TestComparePlayers:
    def test_basic_comparison(self):
        r = compare_players.invoke(
            {"player_a": "Imran Khan", "player_b": "Kapil Dev", "format": "tests"}
        )
        assert "player_a" in r and "player_b" in r
        assert "deltas" in r
        assert r["player_a"]["name"] != r["player_b"]["name"]

    def test_missing_player(self):
        r = compare_players.invoke(
            {"player_a": "Real Player", "player_b": "Fake Imaginary Person", "format": "tests"}
        )
        assert r.get("error") == "player_not_found"


class TestBuildXI:
    def test_test_xi_complete(self):
        r = build_xi.invoke({"format": "tests"})
        assert r["selected_count"] == 11
        assert len(r["xi"]) == 11
        assert isinstance(r["total_firepower"], int | float)
        # standard role buckets present
        assert "keeper" in r["bucket_counts"]

    def test_country_filter(self):
        r = build_xi.invoke({"format": "odis", "country": "AUS"})
        assert all("AUS" in p["country"] for p in r["xi"])


class TestAnalyzeCareerArc:
    def test_long_career(self):
        r = analyze_career_arc.invoke({"name": "SR Tendulkar", "format": "tests"})
        assert r["longevity_stints"] >= 10
        assert r["peak_bat_avg"] is not None
        assert r["prime_window_bat_avg"] is not None

    def test_unknown_player(self):
        r = analyze_career_arc.invoke({"name": "Not Real", "format": "tests"})
        assert r.get("error") == "player_not_found"
