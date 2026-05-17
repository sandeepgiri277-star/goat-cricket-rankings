"""CLI: ``uv run analyst "your question"``."""

from __future__ import annotations

import json
import typer
from rich.console import Console
from rich.panel import Panel

from analyst.graph import build_graph
from analyst.state import AnalystState

app = typer.Typer(add_completion=False, help="Ask the Cricket Analyst a question.")
console = Console()


@app.command()
def ask(
    question: str = typer.Argument(..., help="Your cricket question."),
    show_trace: bool = typer.Option(
        False, "--trace", help="Print every intermediate message."
    ),
    raw: bool = typer.Option(False, "--raw", help="Print final state as JSON."),
):
    """Run the analyst graph end-to-end on a single question."""
    graph = build_graph()
    initial = AnalystState(question=question)
    result = graph.invoke(initial)

    if raw:
        console.print(json.dumps(result, default=str, indent=2))
        return

    plan = result.get("plan")
    if plan:
        console.print(
            Panel.fit(
                f"[bold]Format:[/bold] {plan.format}\n"
                f"[bold]Rationale:[/bold] {plan.rationale}\n"
                f"[bold]Sub-tasks:[/bold]\n  - "
                + "\n  - ".join(plan.sub_tasks),
                title="Plan",
                border_style="cyan",
            )
        )

    if show_trace:
        for m in result.get("messages", []):
            role = getattr(m, "type", "msg").upper()
            console.print(f"[dim]{role}:[/dim] {str(m.content)[:400]}")

    final = result.get("final")
    if final:
        console.print(
            Panel(
                f"[bold]{final.summary}[/bold]\n\n"
                + "\n".join(f"• {k}" for k in final.key_points)
                + (
                    f"\n\n[dim]Cited: {', '.join(final.cited_players)}[/dim]"
                    if final.cited_players
                    else ""
                ),
                title="Verdict",
                border_style="green",
            )
        )
    else:
        console.print("[red]No final answer produced.[/red]")


if __name__ == "__main__":
    app()
