"""
RAG Evaluation Orchestrator

Runs the full evaluation pipeline:
1. Setup: validate env, check API, prepare output dir
2. Cache disable: flush qa:v1:* keys from Redis
3. Load dataset
4. Query API for each question
5. Compute retrieval metrics (custom)
6. Compute refusal compliance
7. Compute generation metrics (Ragas + Gemini, ~13-17 min on Tier 1; 3 metrics)
8. Run diagnostic engine
9. Write markdown + JSON reports

Usage:
    python evaluation/run_eval.py
    python evaluation/run_eval.py --dataset golden-dataset.json --output results/baseline-2026-06-05/
    python evaluation/run_eval.py --skip-cache-flush
    python evaluation/run_eval.py --max-questions 3  # smoke test with first 3 questions

Requirements:
    - GOOGLE_API_KEY in .env or shell environment
    - NestJS API running on localhost:3000 (or --api-base override)
    - Optional: hybrid-rag-redis Docker container for cache flush
"""

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

import requests
from dotenv import load_dotenv

# Allow running directly as `python evaluation/run_eval.py`: the script's own
# directory lands on sys.path but the repo root doesn't, so `evaluation.*`
# imports would fail. Insert the repo root explicitly (no-op when already
# importable, e.g. via `python -m evaluation.run_eval` or pytest's conftest).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Import all our modules
from evaluation.modules.dataset import load_dataset, Dataset, Question
from evaluation.modules.api_client import ApiClient, QueryResult, Source
from evaluation.modules.retrieval_metrics import (
    compute_per_question_scores,
    aggregate_scores,
    RetrievalScores,
)
from evaluation.modules.generation_metrics import (
    calculate_generation_metrics,
    get_per_question_scores,
)
from evaluation.modules.refusal_metric import (
    check_refusal_compliance,
    get_detailed_checks,
)
from evaluation.modules.diagnosis import diagnose
from evaluation.modules.report import write_markdown_report, write_json_report


# ============================================================
# Configuration
# ============================================================

DEFAULT_DATASET_PATH = "evaluation/golden-dataset.json"
DEFAULT_API_BASE = "http://localhost:3000"
DEFAULT_PER_QUESTION_SLEEP_MS = 200
DEFAULT_REDIS_CONTAINER = "hybrid-rag-redis"
DEFAULT_CACHE_PATTERN = "qa:v1:*"


# ============================================================
# Setup & Validation
# ============================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RAG Evaluation Orchestrator")
    parser.add_argument(
        "--dataset",
        default=DEFAULT_DATASET_PATH,
        help="Path to golden dataset JSON (default: %(default)s)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output directory (default: evaluation/results/baseline-{YYYY-MM-DD}/)",
    )
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="API base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--skip-cache-flush",
        action="store_true",
        help="Skip Redis qa:v1:* cache flush (use for dev iterations)",
    )
    parser.add_argument(
        "--max-questions",
        type=int,
        default=None,
        help="Limit to first N questions (for smoke testing; default: all)",
    )
    parser.add_argument(
        "--per-question-sleep-ms",
        type=int,
        default=DEFAULT_PER_QUESTION_SLEEP_MS,
        help="Sleep between API queries in ms (default: %(default)s)",
    )
    parser.add_argument(
        "--redis-container",
        default=DEFAULT_REDIS_CONTAINER,
        help="Redis Docker container name (default: %(default)s)",
    )
    return parser.parse_args()


def validate_environment() -> None:
    """Check GOOGLE_API_KEY is set. Fail fast if not."""
    load_dotenv()
    if not os.environ.get("GOOGLE_API_KEY"):
        print("ERROR: GOOGLE_API_KEY not found in .env or environment.")
        print("Set it in your .env file or shell:")
        print("  export GOOGLE_API_KEY='your-key-here'")
        sys.exit(1)


def check_api_health(api_base: str) -> None:
    """Check API is reachable before starting the long pipeline."""
    health_url = f"{api_base.rstrip('/')}/health"
    try:
        response = requests.get(health_url, timeout=5)
        if response.status_code != 200:
            print(f"ERROR: API health check failed at {health_url}")
            print(f"  Status: {response.status_code}")
            print(f"  Body: {response.text[:200]}")
            sys.exit(1)
    except requests.RequestException as e:
        print(f"ERROR: Cannot reach API at {health_url}")
        print(f"  Reason: {e}")
        print(f"  Start the NestJS server first: npm run start")
        sys.exit(1)


def prepare_output_dir(output: Optional[str]) -> Path:
    """Create the output directory; default to evaluation/results/baseline-{date}/."""
    if output:
        output_dir = Path(output)
    else:
        date_str = datetime.now().strftime("%Y-%m-%d")
        output_dir = Path(f"evaluation/results/baseline-{date_str}")

    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


# ============================================================
# Cache Management
# ============================================================

def flush_qa_cache(container: str, pattern: str = DEFAULT_CACHE_PATTERN) -> None:
    """
    Remove only qa:v1:* keys from Redis. Other namespaces (ingestion markers,
    rate-limit counters, circuit breaker state) are preserved.

    Fails gracefully — if Docker/Redis is unreachable, prints a warning but
    doesn't abort the eval (cache absence just means cold start, eval still works).
    """
    print(f"  Flushing cache pattern '{pattern}' in container '{container}'...")

    try:
        # Get matching keys
        scan_result = subprocess.run(
            ["docker", "exec", container, "redis-cli", "--scan", "--pattern", pattern],
            capture_output=True, text=True, timeout=30,
        )

        if scan_result.returncode != 0:
            print(f"  WARNING: Cache scan failed (returncode={scan_result.returncode})")
            print(f"  stderr: {scan_result.stderr[:300]}")
            print(f"  Continuing without cache flush — eval may include cached responses")
            return

        keys = [k.strip() for k in scan_result.stdout.split('\n') if k.strip()]

        if not keys:
            print(f"  ✓ Cache already empty (no matching keys)")
            return

        # Batch delete (in chunks to avoid command line length limits)
        chunk_size = 100
        deleted_total = 0
        for i in range(0, len(keys), chunk_size):
            chunk = keys[i:i + chunk_size]
            del_result = subprocess.run(
                ["docker", "exec", container, "redis-cli", "DEL", *chunk],
                capture_output=True, text=True, timeout=30,
            )
            if del_result.returncode == 0:
                try:
                    deleted_total += int(del_result.stdout.strip())
                except ValueError:
                    pass

        print(f"  ✓ Flushed {deleted_total} cache keys")

    except subprocess.TimeoutExpired:
        print(f"  WARNING: Cache flush timeout — continuing without flush")
    except FileNotFoundError:
        print(f"  WARNING: 'docker' command not found — skipping cache flush")
    except Exception as e:
        print(f"  WARNING: Cache flush failed: {e}")
        print(f"  Continuing without flush — eval may include cached responses")


# ============================================================
# Query Phase
# ============================================================

def query_all_questions(
    questions: List[Question],
    api_base: str,
    sleep_ms: int,
) -> Tuple[List[QueryResult], List[Tuple[Question, str]]]:
    """
    Query the API for each question, preserving order.

    Failed queries get an empty QueryResult placeholder (to keep indices aligned)
    and are also collected in the failed list for reporting.

    Returns:
        (query_results, failed_questions)
    """
    client = ApiClient(base_url=api_base)
    query_results = []
    failed_questions = []

    for i, question in enumerate(questions, 1):
        truncated = question.question[:80] + ("..." if len(question.question) > 80 else "")
        print(f"  [{i}/{len(questions)}] {question.id}: {truncated}")

        try:
            result = client.query(question.question)
            query_results.append(result)
            print(f"     ✓ Got {len(result.sources)} sources, answer {len(result.answer)} chars")
        except Exception as e:
            print(f"     ✗ FAILED: {type(e).__name__}: {e}")
            failed_questions.append((question, str(e)))
            # Empty placeholder to preserve order
            query_results.append(QueryResult(
                question=question.question,
                answer="[QUERY FAILED]",
                sources=[],
            ))

        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000)

    return query_results, failed_questions


# ============================================================
# Main Pipeline
# ============================================================

def main():
    args = parse_args()

    print("=" * 70)
    print("RAG Evaluation Orchestrator")
    print("=" * 70)

    run_start_time = time.time()
    run_date = datetime.now().strftime("%Y-%m-%d")

    # ----------------------------------------------------------------
    # [1/9] Setup
    # ----------------------------------------------------------------
    print("\n[1/9] Setup & validation...")
    validate_environment()
    print(f"  ✓ GOOGLE_API_KEY found")

    check_api_health(args.api_base)
    print(f"  ✓ API healthy at {args.api_base}")

    output_dir = prepare_output_dir(args.output)
    print(f"  ✓ Output directory: {output_dir}")

    # ----------------------------------------------------------------
    # [2/9] Cache flush
    # ----------------------------------------------------------------
    print("\n[2/9] Cache disable (Redis qa:v1:* flush)...")
    if args.skip_cache_flush:
        print("  Skipped (--skip-cache-flush)")
    else:
        flush_qa_cache(args.redis_container)

    # ----------------------------------------------------------------
    # [3/9] Load dataset
    # ----------------------------------------------------------------
    print("\n[3/9] Loading dataset...")
    dataset = load_dataset(Path(args.dataset))

    questions = dataset.questions
    if args.max_questions:
        questions = questions[:args.max_questions]
        print(f"  ⚠ Limited to first {args.max_questions} questions for smoke testing")

    print(f"  ✓ Loaded {len(questions)} questions (of {dataset.total_questions} total)")
    print(f"  Distribution: {dataset.distribution}")

    # ----------------------------------------------------------------
    # [4/9] Query API
    # ----------------------------------------------------------------
    print(f"\n[4/9] Querying API for {len(questions)} questions...")
    query_start = time.time()
    query_results, failed_questions = query_all_questions(
        questions, args.api_base, args.per_question_sleep_ms,
    )
    query_elapsed = time.time() - query_start

    successful = len(questions) - len(failed_questions)
    print(f"  ✓ Query phase complete in {query_elapsed/60:.1f} min")
    print(f"     Successful: {successful}/{len(questions)}")
    if failed_questions:
        print(f"     Failed: {len(failed_questions)}")
        for q, err in failed_questions[:5]:
            print(f"       - {q.id}: {err[:80]}")

    # ----------------------------------------------------------------
    # [5/9] Retrieval metrics
    # ----------------------------------------------------------------
    print("\n[5/9] Computing retrieval metrics...")
    per_question_retrieval = []
    for q, result in zip(questions, query_results):
        scores = compute_per_question_scores(
            retrieved_ids=result.retrieved_chunk_ids,
            ground_truth_ids=q.ground_truth_chunk_ids,
            k=5,
        )
        per_question_retrieval.append(scores)

    try:
        aggregate_retrieval = aggregate_scores(per_question_retrieval)
        print(f"  ✓ Retrieval aggregate:")
        print(f"     MRR={aggregate_retrieval.mrr:.3f}")
        print(f"     Hit@5={aggregate_retrieval.hit_at_k:.3f}")
        print(f"     Precision@5={aggregate_retrieval.precision_at_k:.3f}")
        print(f"     Recall@5={aggregate_retrieval.recall_at_k:.3f}")
        print(f"     (evaluated {aggregate_retrieval.questions_evaluated}, "
              f"skipped {aggregate_retrieval.questions_skipped})")
    except ValueError as e:
        print(f"  ⚠ Could not aggregate retrieval scores: {e}")
        aggregate_retrieval = None

    # ----------------------------------------------------------------
    # [6/9] Refusal compliance
    # ----------------------------------------------------------------
    print("\n[6/9] Computing refusal compliance...")
    try:
        refusal_score = check_refusal_compliance(questions, query_results)
        per_question_refusal = get_detailed_checks(questions, query_results)
        print(f"  ✓ Refusal compliance: {refusal_score.refusal_compliance:.3f}")
        print(f"     {refusal_score.correctly_refused}/{refusal_score.total_refusal_questions} correctly refused")
        if refusal_score.incorrectly_answered:
            print(f"     Failed: {', '.join(refusal_score.incorrectly_answered)}")
    except ValueError as e:
        print(f"  ⚠ No refusal questions in dataset: {e}")
        refusal_score = None
        per_question_refusal = []

    # ----------------------------------------------------------------
    # [7/9] Generation metrics (Ragas, slow!)
    # ----------------------------------------------------------------
    print("\n[7/9] Computing generation metrics (Ragas + Gemini)...")
    print("  ⏳ This will take ~13-17 minutes on Gemini Tier 1 (15 RPM).")
    print("     Ragas makes ~3 LLM calls per question per metric (3 metrics).")
    print("     Press Ctrl+C to abort (state will be lost).")
    print()

    gen_start = time.time()
    try:
        generation_scores = calculate_generation_metrics(query_results, questions)
        per_question_generation = get_per_question_scores(query_results, questions)
        gen_elapsed = time.time() - gen_start

        print(f"  ✓ Generation metrics computed in {gen_elapsed/60:.1f} min:")
        print(f"     Faithfulness={_fmt(generation_scores.faithfulness)}")
        print(f"     Answer Relevancy={_fmt(generation_scores.answer_relevancy)}")
        print(f"     Context Recall={_fmt(generation_scores.context_recall)}")
    except Exception as e:
        print(f"  ✗ Generation metrics FAILED: {type(e).__name__}: {e}")
        print(f"  Cannot continue without generation metrics.")
        sys.exit(1)

    # ----------------------------------------------------------------
    # [8/9] Diagnosis
    # ----------------------------------------------------------------
    print("\n[8/9] Running diagnostic engine...")
    if aggregate_retrieval is None:
        print("  ⚠ Skipping diagnosis — retrieval scores unavailable")
        diagnostic = None
    else:
        diagnostic = diagnose(aggregate_retrieval, generation_scores, refusal_score)
        print(f"  ✓ Overall health: {diagnostic.overall_health.value}")
        print(f"  Findings: {len(diagnostic.findings)}")
        for f in diagnostic.findings:
            print(f"     [{f.severity.value}] {f.title}")

    # ----------------------------------------------------------------
    # [9/9] Reports
    # ----------------------------------------------------------------
    print("\n[9/9] Writing reports...")

    if diagnostic is None or aggregate_retrieval is None:
        print("  ⚠ Cannot write full report — required data missing")
        print(f"  Partial results saved at: {output_dir}")
        sys.exit(1)

    md_path = output_dir / "baseline.md"
    json_path = output_dir / "baseline.json"

    write_markdown_report(
        output_path=md_path,
        run_date=run_date,
        dataset_version=dataset.version,
        retrieval=aggregate_retrieval,
        generation=generation_scores,
        refusal=refusal_score,
        diagnostic=diagnostic,
        questions=questions,
        query_results=query_results,
        per_question_retrieval=per_question_retrieval,
        per_question_generation=per_question_generation,
        per_question_refusal=per_question_refusal,
    )
    print(f"  ✓ Markdown report: {md_path}")

    write_json_report(
        output_path=json_path,
        run_date=run_date,
        dataset_version=dataset.version,
        retrieval=aggregate_retrieval,
        generation=generation_scores,
        refusal=refusal_score,
        diagnostic=diagnostic,
        questions=questions,
        query_results=query_results,
        per_question_retrieval=per_question_retrieval,
        per_question_generation=per_question_generation,
        per_question_refusal=per_question_refusal,
    )
    print(f"  ✓ JSON report: {json_path}")

    # ----------------------------------------------------------------
    # Final summary
    # ----------------------------------------------------------------
    total_elapsed = time.time() - run_start_time
    print("\n" + "=" * 70)
    print(f"EVAL COMPLETE — {total_elapsed/60:.1f} minutes total")
    print("=" * 70)
    print(f"  Questions: {len(questions)} ({successful} successful, {len(failed_questions)} failed)")
    print(f"  Overall health: {diagnostic.overall_health.value}")
    print(f"  Reports: {output_dir}")
    print(f"\nOpen the markdown report to review:")
    print(f"  {md_path}\n")


def _fmt(value):
    """Format a metric value, showing N/A for None."""
    return "N/A" if value is None else f"{value:.3f}"


if __name__ == "__main__":
    main()
