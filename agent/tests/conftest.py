"""Ensure src/ is importable when running pytest from agent/.

Belt-and-braces alongside the editable install, which can flake on
multi-package src layouts with hatchling.
"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
