"""Graph wiring tests. No LLM calls."""

from __future__ import annotations

from analyst.graph import build_graph
from analyst.state import AnalystState, Critique, FinalAnswer, Plan


def test_graph_compiles_all_nodes():
    g = build_graph()
    expected = {
        "__start__",
        "planner",
        "retriever",
        "plan_gate",
        "tool_executor",
        "synthesizer",
        "critic",
    }
    assert expected.issubset(set(g.nodes.keys()))


def test_critique_passed_property():
    c = Critique(grounded=True, addresses_question=True, structure_ok=True)
    assert c.passed
    bad = Critique(grounded=False, addresses_question=True, structure_ok=True, issues=["x"])
    assert not bad.passed


def test_state_defaults():
    s = AnalystState(question="hi")
    assert s.tool_iterations == 0
    assert s.revision_count == 0
    assert s.max_tool_iterations == 4
    assert s.max_revisions == 2
    assert s.plan is None
    assert s.final is None


def test_pydantic_models_roundtrip():
    p = Plan(format="tests", rationale="r", sub_tasks=["a", "b"])
    assert p.model_dump()["format"] == "tests"
    f = FinalAnswer(summary="s", key_points=["k"], cited_players=["x"])
    assert f.model_dump()["summary"] == "s"
