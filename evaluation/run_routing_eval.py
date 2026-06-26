"""
Tool-Use Routing Evaluation Orchestrator (Phase 5.5)

A SEPARATE runner from run_eval.py. Scores ONLY the tool-use routing dimensions —
routing accuracy, deterministic value checks, and scope-honesty — against
evaluation/tool-routing-dataset.json. NO Ragas / faithfulness / context-recall:
the tool-use path reuses the Phase-4 retrieval engine, whose generation quality
was already measured in Phase 4. (Deferred to the agentic phase.)

Pipeline:
1. Setup: validate env, check API health, prepare output dir.
2. Load tool-routing-dataset.json (minimal loader — distinct schema from the
   Phase-4 golden dataset).
3. TOOL-USE-PATH GUARD (critical): probe one known tool-use question and assert
   the response `path == 'tool_use'`. TOOL_USE_ENABLED is read ONCE at API
   startup (ConfigModule cache:true), so a direct-mode API would otherwise score
   as 33 routing failures. Fail loud instead.
4. Query the live API for each question (real Gemini calls, sequential).
5. Score: routing_metric.score_routing_question per question + aggregate_routing.
6. Write routing-eval.md + routing-eval.json.

Usage (the API MUST be booted in tool-use mode — see HOW TO RUN at the bottom):
    TOOL_USE_ENABLED=true npm run start:dev   # in one shell
    python evaluation/run_routing_eval.py     # in another

    python evaluation/run_routing_eval.py --output results/routing-2026-06-26/
    python evaluation/run_routing_eval.py --max-questions 3   # smoke

Requirements:
    - GOOGLE_API_KEY in .env or shell.
    - NestJS API on localhost:3000 booted with TOOL_USE_ENABLED=true.
"""

import argparse
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv

# Allow `python evaluation/run_routing_eval.py` (repo root onto sys.path).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evaluation.modules.api_client import ApiClient, QueryResult
from evaluation.modules.routing_metric import (
    ROUTING_CATEGORIES,
    SEARCH_CONTENT_TOOL,
    QUERY_METADATA_TOOL,
    RoutingCheck,
    RoutingAccuracyScore,
    score_routing_question,
    aggregate_routing,
)
from evaluation.modules.routing_report import (
    build_markdown_report,
    build_json_report,
)


# ============================================================
# Configuration
# ============================================================

DEFAULT_DATASET_PATH = "evaluation/tool-routing-dataset.json"
DEFAULT_API_BASE = "http://localhost:3000"
DEFAULT_PER_QUESTION_SLEEP_MS = 200

# Path values the API reports (mirror answer-response.dto.ts AnswerPath).
PATH_TOOL_USE = "tool_use"
PATH_DIRECT = "direct"

# Probe question for the tool-use-path guard. A whole-collection count
# unambiguously routes through query_metadata, so in tool-use mode the response
# `path` is 'tool_use'; in direct mode (TOOL_USE_ENABLED=false) it is 'direct'.
PROBE_QUESTION = "How many episodes are in the collection in total?"

# Allowed routing-tool vocabulary for dataset validation.
_VALID_TOOLS = frozenset({SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL})
_VALID_CATEGORIES = frozenset(ROUTING_CATEGORIES)


# ============================================================
# Dataset (minimal loader — tool-routing schema)
# ============================================================

@dataclass(frozen=True)
class RoutingQuestion:
    id: str
    category: str
    question: str
    expected_tools: List[str]
    expected_value_or_check: str
    ground_truth: str
    notes: str


@dataclass(frozen=True)
class RoutingDataset:
    version: str
    created_at: str
    total_questions: int
    distribution: Dict[str, int]
    questions: List[RoutingQuestion]


def load_routing_dataset(path: Path) -> RoutingDataset:
    """Load + validate tool-routing-dataset.json. Fail loud on schema drift."""
    import json

    if not path.exists():
        raise FileNotFoundError(f"Routing dataset not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    required_top = {"version", "created_at", "total_questions", "distribution", "questions"}
    missing = required_top - set(data.keys())
    if missing:
        raise ValueError(f"Routing dataset missing keys: {missing}")

    questions = [_parse_routing_question(q) for q in data["questions"]]

    if len(questions) != data["total_questions"]:
        raise ValueError(
            f"Question count mismatch: declared {data['total_questions']}, "
            f"found {len(questions)}"
        )

    # Distribution sanity check (declared vs actual per category).
    actual: Dict[str, int] = {}
    for q in questions:
        actual[q.category] = actual.get(q.category, 0) + 1
    if actual != data["distribution"]:
        raise ValueError(
            f"Distribution mismatch: declared {data['distribution']}, actual {actual}"
        )

    ids = [q.id for q in questions]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate question IDs detected")

    return RoutingDataset(
        version=data["version"],
        created_at=data["created_at"],
        total_questions=data["total_questions"],
        distribution=data["distribution"],
        questions=questions,
    )


def _parse_routing_question(data: dict) -> RoutingQuestion:
    required = {
        "id", "category", "question", "expected_tools",
        "expected_value_or_check", "ground_truth", "notes",
    }
    missing = required - set(data.keys())
    if missing:
        raise ValueError(f"Question {data.get('id', '?')} missing fields: {missing}")

    if data["category"] not in _VALID_CATEGORIES:
        raise ValueError(f"Question {data['id']}: invalid category '{data['category']}'")

    if not isinstance(data["expected_tools"], list):
        raise ValueError(f"Question {data['id']}: expected_tools must be a list")

    bad_tools = [t for t in data["expected_tools"] if t not in _VALID_TOOLS]
    if bad_tools:
        raise ValueError(f"Question {data['id']}: unknown tool(s) {bad_tools}")

    return RoutingQuestion(
        id=data["id"],
        category=data["category"],
        question=data["question"],
        expected_tools=list(data["expected_tools"]),
        expected_value_or_check=data["expected_value_or_check"],
        ground_truth=data["ground_truth"],
        notes=data["notes"],
    )


# ============================================================
# Setup & Validation
# ============================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tool-Use Routing Evaluation Orchestrator")
    parser.add_argument("--dataset", default=DEFAULT_DATASET_PATH,
                        help="Path to tool-routing dataset JSON (default: %(default)s)")
    parser.add_argument("--output", default=None,
                        help="Output dir (default: evaluation/results/routing-{YYYY-MM-DD}/)")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE,
                        help="API base URL (default: %(default)s)")
    parser.add_argument("--max-questions", type=int, default=None,
                        help="Limit to first N questions (smoke test; default: all)")
    parser.add_argument("--per-question-sleep-ms", type=int,
                        default=DEFAULT_PER_QUESTION_SLEEP_MS,
                        help="Sleep between API queries in ms (default: %(default)s)")
    return parser.parse_args()


def validate_environment() -> None:
    load_dotenv()
    if not os.environ.get("GOOGLE_API_KEY"):
        print("ERROR: GOOGLE_API_KEY not found in .env or environment.")
        sys.exit(1)


def check_api_health(api_base: str) -> None:
    health_url = f"{api_base.rstrip('/')}/health"
    try:
        response = requests.get(health_url, timeout=5)
        if response.status_code != 200:
            print(f"ERROR: API health check failed at {health_url} "
                  f"(status {response.status_code})")
            sys.exit(1)
    except requests.RequestException as e:
        print(f"ERROR: Cannot reach API at {health_url}: {e}")
        print("  Start the NestJS server first (in tool-use mode): "
              "TOOL_USE_ENABLED=true npm run start:dev")
        sys.exit(1)


def prepare_output_dir(output: Optional[str]) -> Path:
    if output:
        output_dir = Path(output)
    else:
        date_str = datetime.now().strftime("%Y-%m-%d")
        output_dir = Path(f"evaluation/results/routing-{date_str}")
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def assert_tool_use_mode(api_base: str) -> None:
    """CRITICAL guard. Probe one known tool-use question; the response `path` must
    be 'tool_use'. TOOL_USE_ENABLED is snapshotted at API startup (cache:true), so
    a direct-mode API can't be fixed mid-run — fail loud and stop rather than
    silently scoring every question as a misroute."""
    print("  Probing tool-use path...")
    client = ApiClient(base_url=api_base)
    try:
        result = client.query(PROBE_QUESTION)
    except Exception as e:
        print(f"ERROR: Tool-use probe request failed: {type(e).__name__}: {e}")
        sys.exit(1)

    if result.path == PATH_TOOL_USE:
        print(f"  ✓ Tool-use path active (probe path='{result.path}', "
              f"toolUsed={result.tool_used})")
        return

    print("=" * 70)
    print("ERROR: API is NOT in tool-use mode.")
    print(f"  Probe question returned path='{result.path}' (expected '{PATH_TOOL_USE}').")
    print("  TOOL_USE_ENABLED is read once at API startup (ConfigModule cache:true),")
    print("  so it CANNOT be toggled on a running server. Restart the API with the")
    print("  flag set in the SHELL before boot, then re-run this eval:")
    print()
    print("      TOOL_USE_ENABLED=true npm run start:dev")
    print()
    print("  Refusing to score a direct-path run (it would read as 33 misroutes).")
    print("=" * 70)
    sys.exit(1)


# ============================================================
# Query Phase
# ============================================================

def query_all_questions(
    questions: List[RoutingQuestion],
    api_base: str,
    sleep_ms: int,
) -> Tuple[List[QueryResult], List[Tuple[RoutingQuestion, str]]]:
    """Query the API per question, preserving order. Failures get an empty
    placeholder (path=None → counts as a non-tool-use misroute in scoring)."""
    client = ApiClient(base_url=api_base)
    query_results: List[QueryResult] = []
    failed: List[Tuple[RoutingQuestion, str]] = []

    for i, question in enumerate(questions, 1):
        truncated = question.question[:70] + ("..." if len(question.question) > 70 else "")
        print(f"  [{i}/{len(questions)}] {question.id} ({question.category}): {truncated}")
        try:
            result = client.query(question.question)
            query_results.append(result)
            print(f"     ✓ path={result.path} toolUsed={result.tool_used}")
        except Exception as e:
            print(f"     ✗ FAILED: {type(e).__name__}: {e}")
            failed.append((question, str(e)))
            query_results.append(QueryResult(
                question=question.question, answer="[QUERY FAILED]", sources=[],
            ))
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000)

    return query_results, failed


# ============================================================
# Scoring (pure)
# ============================================================

def build_routing_checks(
    questions: List[RoutingQuestion],
    query_results: List[QueryResult],
) -> List[RoutingCheck]:
    """Score every question. Pure — no network. Same order as `questions`."""
    if len(questions) != len(query_results):
        raise ValueError(
            f"Length mismatch: {len(questions)} questions vs {len(query_results)} results"
        )
    checks = []
    for q, r in zip(questions, query_results):
        checks.append(score_routing_question(
            question_id=q.id,
            category=q.category,
            expected_tools=q.expected_tools,
            tool_used=r.tool_used,
            answer=r.answer,
            expected_value_or_check=q.expected_value_or_check,
        ))
    return checks


# ============================================================
# Main Pipeline
# ============================================================

def main():
    args = parse_args()

    print("=" * 70)
    print("Tool-Use Routing Evaluation Orchestrator (Phase 5.5)")
    print("=" * 70)

    run_start = time.time()
    run_date = datetime.now().strftime("%Y-%m-%d")

    # [1/6] Setup
    print("\n[1/6] Setup & validation...")
    validate_environment()
    print("  ✓ GOOGLE_API_KEY found")
    check_api_health(args.api_base)
    print(f"  ✓ API healthy at {args.api_base}")
    output_dir = prepare_output_dir(args.output)
    print(f"  ✓ Output directory: {output_dir}")

    # [2/6] Load dataset
    print("\n[2/6] Loading routing dataset...")
    dataset = load_routing_dataset(Path(args.dataset))
    questions = dataset.questions
    if args.max_questions:
        questions = questions[:args.max_questions]
        print(f"  ⚠ Limited to first {args.max_questions} questions (smoke)")
    print(f"  ✓ Loaded {len(questions)} questions (of {dataset.total_questions})")
    print(f"  Distribution: {dataset.distribution}")

    # [3/6] Tool-use-path guard (CRITICAL)
    print("\n[3/6] Tool-use-path guard...")
    assert_tool_use_mode(args.api_base)

    # [4/6] Query
    print(f"\n[4/6] Querying API for {len(questions)} questions (real Gemini calls)...")
    query_start = time.time()
    query_results, failed = query_all_questions(
        questions, args.api_base, args.per_question_sleep_ms,
    )
    print(f"  ✓ Query phase complete in {(time.time() - query_start) / 60:.1f} min "
          f"({len(questions) - len(failed)}/{len(questions)} ok)")
    if failed:
        print(f"     Failed: {len(failed)}")
        for q, err in failed[:5]:
            print(f"       - {q.id}: {err[:80]}")

    # [5/6] Score
    print("\n[5/6] Scoring routing / value / honesty...")
    checks = build_routing_checks(questions, query_results)
    aggregate = aggregate_routing(checks)
    print(f"  ✓ Routing accuracy: {aggregate.overall_routing_accuracy:.3f} "
          f"({aggregate.routing_correct}/{aggregate.total_questions})")
    print(f"  ✓ Value-check pass rate: {_fmt(aggregate.value_check_pass_rate)} "
          f"({aggregate.value_passed}/{aggregate.value_checked} deterministic)")
    print(f"  ✓ Honesty pass rate: {_fmt(aggregate.honesty_pass_rate)} "
          f"({aggregate.honesty_passed}/{aggregate.honesty_checked} scope-honesty)")

    # [6/6] Reports
    print("\n[6/6] Writing reports...")
    md_path = output_dir / "routing-eval.md"
    json_path = output_dir / "routing-eval.json"

    md = build_markdown_report(
        run_date=run_date, dataset_version=dataset.version,
        aggregate=aggregate, questions=questions,
        query_results=query_results, checks=checks,
        failed_count=len(failed), api_base=args.api_base,
    )
    md_path.write_text(md, encoding="utf-8")
    print(f"  ✓ Markdown report: {md_path}")

    payload = build_json_report(
        run_date=run_date, dataset_version=dataset.version,
        aggregate=aggregate, questions=questions,
        query_results=query_results, checks=checks,
    )
    import json
    json_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    print(f"  ✓ JSON report: {json_path}")

    total_elapsed = time.time() - run_start
    print("\n" + "=" * 70)
    print(f"ROUTING EVAL COMPLETE — {total_elapsed / 60:.1f} min")
    print("=" * 70)
    print(f"  Routing accuracy: {aggregate.overall_routing_accuracy:.3f} "
          f"({aggregate.routing_correct}/{aggregate.total_questions})")
    print(f"  Reports: {output_dir}\n")


def _fmt(value: Optional[float]) -> str:
    return "N/A" if value is None else f"{value:.3f}"


if __name__ == "__main__":
    main()
