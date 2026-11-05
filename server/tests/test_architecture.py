"""Prevent infrastructure/framework imports from creeping back into the core."""

import ast
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1] / "src" / "dogo_server"


@pytest.mark.parametrize(
    "layer,allowed",
    [
        ("domain", {"domain"}),
        ("application", {"application", "domain"}),
        ("infrastructure", {"application", "domain", "infrastructure", "config"}),
        ("interfaces", {"application", "domain", "interfaces", "config"}),
    ],
)
def test_dependency_direction(layer, allowed):
    for path in (ROOT / layer).rglob("*.py"):
        package = ".".join(path.relative_to(ROOT.parent).parts[:-1])
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                modules = [name.name for name in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [
                    importlib.util.resolve_name("." * node.level + (node.module or ""), package)
                ]
            else:
                continue
            for module in modules:
                parts = module.split(".")
                if parts[0] == "dogo_server":
                    assert len(parts) > 1 and parts[1] in allowed, (path, module)
                elif layer in {"domain", "application"}:
                    assert parts[0] in sys.stdlib_module_names, (path, module)
