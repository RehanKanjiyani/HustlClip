"""The Kaggle notebook is generated; keep it in sync and syntactically valid.

This cannot prove the notebook works on Kaggle (that needs a Kaggle GPU
session), but it catches the failures that are checkable here: a stale
generated file, a cell that doesn't parse, and a CLI flag that doesn't exist.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "notebooks" / "HustlClip_Kaggle.ipynb"


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_notebook", ROOT / "notebooks" / "build_notebook.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_notebook_matches_its_source() -> None:
    built = load_builder().build()
    committed = json.loads(NOTEBOOK.read_text(encoding="utf-8"))

    assert committed == built, "Run `python notebooks/build_notebook.py` and commit the result."


@pytest.mark.parametrize("index", range(len(load_builder().build()["cells"])))
def test_every_code_cell_compiles(index: int) -> None:
    cell = load_builder().build()["cells"][index]
    if cell["cell_type"] != "code":
        pytest.skip("markdown")

    compile("".join(cell["source"]), f"cell{index}", "exec")


def test_cli_flags_used_by_the_notebook_exist() -> None:
    from autoclip.cli import app
    from typer.testing import CliRunner

    help_text = CliRunner().invoke(app, ["clip", "--help"], env={"COLUMNS": "200"}).output
    source = "".join("".join(c["source"]) for c in load_builder().build()["cells"])

    for flag in set(re.findall(r'"(--[a-z-]+)"', source)):
        if flag in ("--host", "--port", "--no-open", "--no-autoupdate", "--url", "--python"):
            continue  # serve / cloudflared / uv flags, checked below or external
        assert flag in help_text, f"hustlclip clip has no {flag}"

    serve_help = CliRunner().invoke(app, ["serve", "--help"], env={"COLUMNS": "200"}).output
    for flag in ("--host", "--port", "--no-open"):
        assert flag in serve_help
