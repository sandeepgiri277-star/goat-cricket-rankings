"""Pydantic state model for the analyst graph.

LangGraph passes this object between nodes. Each node returns a partial
dict that gets merged in. Keeping every piece explicit pays off when you
add a critic loop: you can introspect *exactly* what each step produced.
"""

from __future__ import annotations

from typing import Annotated, Literal

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


Format = Literal["tests", "odis", "t20is", "ipl"]


class Plan(BaseModel):
    """The planner's structured intent for a user question."""

    format: Format = Field(description="Cricket format relevant to the question.")
    rationale: str = Field(description="One-sentence reasoning for the plan.")
    sub_tasks: list[str] = Field(
        default_factory=list, description="Ordered atomic steps the agent will take."
    )


class FinalAnswer(BaseModel):
    """The synthesizer's grounded final response."""

    summary: str = Field(description="2-5 sentence verdict, citing numbers.")
    key_points: list[str] = Field(default_factory=list)
    cited_players: list[str] = Field(default_factory=list)


class Critique(BaseModel):
    """Critic's evaluation of a draft answer."""

    grounded: bool = Field(description="Are all numerical claims backed by the research log?")
    addresses_question: bool = Field(description="Does the answer actually address the user's question?")
    structure_ok: bool = Field(
        description="Are summary length, key_points count, and citations well-formed?"
    )
    issues: list[str] = Field(
        default_factory=list,
        description="Concrete problems found; empty if the answer passes.",
    )
    suggested_followups: list[str] = Field(
        default_factory=list,
        description="If issues exist, concrete next steps (e.g. 'fetch X', 'recheck Y').",
    )

    @property
    def passed(self) -> bool:
        return self.grounded and self.addresses_question and self.structure_ok


class AnalystState(BaseModel):
    """Shared state across the graph. Each node mutates a subset."""

    question: str
    messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)

    plan: Plan | None = None
    plan_approved: bool = False
    require_approval: bool = False

    retrieved_context: str | None = None

    tool_iterations: int = 0
    max_tool_iterations: int = 4

    draft: FinalAnswer | None = None
    critique: Critique | None = None
    revision_count: int = 0
    max_revisions: int = 2

    final: FinalAnswer | None = None

    model_config = {"arbitrary_types_allowed": True}
