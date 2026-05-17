"""Environment-driven configuration for the analyst."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


REPO_ROOT = Path(__file__).resolve().parents[3]


def _find_docs_dir() -> Path:
    candidates = [
        Path(os.environ.get("ANALYST_DOCS_DIR", "")) if os.environ.get("ANALYST_DOCS_DIR") else None,
        REPO_ROOT / "docs",
        Path("/root/docs"),  # Modal mount
        Path.cwd() / "docs",
    ]
    for c in candidates:
        if c and c.exists():
            return c
    return REPO_ROOT / "docs"


DOCS_DIR = _find_docs_dir()

FORMAT_FILES = {
    "tests": DOCS_DIR / "rankings.json",
    "odis": DOCS_DIR / "odi_rankings.json",
    "t20is": DOCS_DIR / "t20i_rankings.json",
    "ipl": DOCS_DIR / "ipl_rankings.json",
}


@lru_cache(maxsize=1)
def settings() -> dict:
    return {
        "anthropic_api_key": os.environ.get("ANTHROPIC_API_KEY"),
        "model": os.environ.get("ANALYST_MODEL", "claude-haiku-4-5"),
        "langfuse_public_key": os.environ.get("LANGFUSE_PUBLIC_KEY"),
        "langfuse_secret_key": os.environ.get("LANGFUSE_SECRET_KEY"),
        "langfuse_host": os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
    }
