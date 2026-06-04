import sys
from pathlib import Path

import pytest

# Ensure the repo root is in path so tests can `from evaluation.modules.X import Y`
sys.path.insert(0, str(Path(__file__).parent.parent))


def pytest_addoption(parser):
    parser.addoption(
        "--slow",
        action="store_true",
        default=False,
        help="run slow tests (real LLM calls, e.g. Ragas + Gemini smoke test)",
    )


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )


def pytest_collection_modifyitems(config, items):
    if config.getoption("--slow"):
        return  # --slow given: run everything
    skip_slow = pytest.mark.skip(reason="slow test — run with 'pytest --slow'")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip_slow)
