"""Human-in-the-loop gate.

When ``require_approval`` is set AND the plan has multiple sub-tasks, this
node calls LangGraph's ``interrupt()`` to pause the graph and surface the
plan to the caller. The caller resumes with ``Command(resume=True)`` after
the user clicks "approve" in the UI.

In CLI mode (no caller waiting) this node short-circuits to auto-approve so
the dev loop stays fast.
"""

from __future__ import annotations

from langgraph.types import interrupt

from analyst.state import AnalystState


def plan_gate_node(state: AnalystState) -> dict:
    if not state.require_approval or state.plan_approved:
        return {"plan_approved": True}

    plan = state.plan
    if plan is None or len(plan.sub_tasks) <= 1:
        return {"plan_approved": True}

    decision = interrupt(
        {
            "kind": "plan_approval",
            "format": plan.format,
            "rationale": plan.rationale,
            "sub_tasks": plan.sub_tasks,
        }
    )
    approved = bool(decision) if not isinstance(decision, dict) else bool(decision.get("approved"))
    return {"plan_approved": approved}


def plan_gate_branch(state: AnalystState) -> str:
    return "proceed" if state.plan_approved else "halt"
