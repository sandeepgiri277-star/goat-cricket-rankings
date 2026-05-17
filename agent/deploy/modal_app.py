"""Modal deployment for the Cricket Analyst.

Usage:
    pip install modal
    modal token new           # one-time
    modal secret create cricket-analyst \
        ANTHROPIC_API_KEY=sk-ant-... \
        LANGFUSE_PUBLIC_KEY=pk-lf-... \
        LANGFUSE_SECRET_KEY=sk-lf-... \
        LANGFUSE_HOST=https://cloud.langfuse.com
    modal deploy deploy/modal_app.py

Run from the repo's ``agent/`` directory. ``modal deploy`` prints a public
URL like ``https://you--cricket-analyst-fastapi-app.modal.run`` — point the
Cloudflare worker at that URL.

Why Modal:
- Free tier has $30/mo compute credit (enough for thousands of agent runs)
- Cold starts under 2s for this size of image
- Built-in secret management, no separate Vault
- ``@modal.asgi_app`` makes any FastAPI app deployable in 4 lines
"""

from __future__ import annotations

from pathlib import Path

import modal

REPO_ROOT = Path(__file__).resolve().parents[2]

app = modal.App("cricket-analyst")

image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install_from_pyproject(str(REPO_ROOT / "agent" / "pyproject.toml"))
    .add_local_dir(str(REPO_ROOT / "agent" / "src"), remote_path="/root/src")
    .add_local_dir(str(REPO_ROOT / "docs"), remote_path="/root/docs")
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("cricket-analyst")],
    timeout=120,
    memory=1024,
    min_containers=1,  # keep one warm so first request isn't a cold start
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/root/src")
    from api.main import app as fastapi_app

    return fastapi_app
