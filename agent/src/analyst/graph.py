"""LangGraph topology for the Cricket Analyst.

Full pipeline (week 2):

    START
      │
      ▼
    planner ─────► retriever ─────► plan_gate ──halt──► END
                                        │
                                      proceed
                                        │
                                        ▼
                                  tool_executor ◄──┐
                                        │          │
                                  more tools?──────┘
                                        │
                                  research done
                                        │
                                        ▼
                                  synthesizer ◄────┐
                                        │          │
                                        ▼          │
                                     critic ──revise┘
                                        │
                                      done
                                        │
                                        ▼
                                       END

Key design choices:
- ``retriever`` runs after ``planner`` so we know which format to search.
- ``plan_gate`` is a no-op unless ``require_approval`` is set; in HITL mode
  it interrupts and waits for the caller to confirm the plan.
- ``critic`` decides PASS (→ END) or REVISE (→ synthesizer with critique
  context). The synthesizer's revision cap lives on ``state.max_revisions``.

Checkpointing: when the graph is built with ``checkpointer=MemorySaver()``
the HITL interrupt can resume cleanly. The FastAPI server passes per-session
checkpointers; the CLI uses the default (no checkpointer).
"""

from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from analyst.nodes.critic import critic_branch, critic_node
from analyst.nodes.plan_gate import plan_gate_branch, plan_gate_node
from analyst.nodes.planner import planner_node
from analyst.nodes.retriever import retriever_node
from analyst.nodes.synthesizer import synthesizer_node
from analyst.nodes.tool_executor import should_continue, tool_executor_node
from analyst.state import AnalystState


def build_graph(checkpointer: MemorySaver | None = None):
    g = StateGraph(AnalystState)
    g.add_node("planner", planner_node)
    g.add_node("retriever", retriever_node)
    g.add_node("plan_gate", plan_gate_node)
    g.add_node("tool_executor", tool_executor_node)
    g.add_node("synthesizer", synthesizer_node)
    g.add_node("critic", critic_node)

    g.add_edge(START, "planner")
    g.add_edge("planner", "retriever")
    g.add_edge("retriever", "plan_gate")
    g.add_conditional_edges(
        "plan_gate",
        plan_gate_branch,
        {"proceed": "tool_executor", "halt": END},
    )
    g.add_conditional_edges(
        "tool_executor",
        should_continue,
        {"tools": "tool_executor", "synthesize": "synthesizer"},
    )
    g.add_edge("synthesizer", "critic")
    g.add_conditional_edges(
        "critic",
        critic_branch,
        {"revise": "synthesizer", "done": END},
    )

    if checkpointer is not None:
        return g.compile(checkpointer=checkpointer)
    return g.compile()
