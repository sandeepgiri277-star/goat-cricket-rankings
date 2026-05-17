"""LangFuse tracing helpers.

If ``LANGFUSE_PUBLIC_KEY`` and ``LANGFUSE_SECRET_KEY`` are set, every node
gets wrapped in a span and traces show up in cloud.langfuse.com. If they're
not set, ``observe`` is a transparent no-op so local dev never breaks on
missing creds.

Usage pattern:

    from analyst.tracing import observe

    @observe(name="planner")
    def planner_node(state): ...
"""

from __future__ import annotations

import functools
from typing import Any, Callable

from analyst.config import settings

_langfuse_available = False
_observe_impl: Callable | None = None

try:
    cfg = settings()
    if cfg.get("langfuse_public_key") and cfg.get("langfuse_secret_key"):
        from langfuse.decorators import observe as _lf_observe  # type: ignore

        _observe_impl = _lf_observe
        _langfuse_available = True
except Exception:
    _langfuse_available = False


def observe(name: str | None = None) -> Callable:
    """Decorate a function with LangFuse tracing (or no-op if disabled)."""

    if _langfuse_available and _observe_impl is not None:
        if name:
            return _observe_impl(name=name)
        return _observe_impl()

    def passthrough(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def inner(*args: Any, **kwargs: Any) -> Any:
            return fn(*args, **kwargs)

        return inner

    return passthrough


def trace_enabled() -> bool:
    return _langfuse_available


def get_trace_url() -> str | None:
    """Best-effort URL for the current trace (LangFuse only)."""
    if not _langfuse_available:
        return None
    try:
        from langfuse.decorators import langfuse_context  # type: ignore

        return langfuse_context.get_current_trace_url()
    except Exception:
        return None
