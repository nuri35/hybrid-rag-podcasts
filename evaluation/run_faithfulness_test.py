"""
Faithfulness audit test — compare excerpt vs full chunk text impact on Ragas scores.

Replays 4 specific questions from baseline-2026-06-06/baseline.json through
Ragas evaluation TWICE: once with excerpts (old behavior), once with full chunks
(new). Compares Faithfulness, Context Recall, and Answer Relevancy.

DOES NOT call the NestJS API — uses cached query_results from baseline.json.

Audit tool — do not commit. Usage (repo root, venv):
    python evaluation/run_faithfulness_test.py
"""

import json
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

# Allow running directly (mirrors run_eval.py bootstrap).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evaluation.modules.dataset import Question
from evaluation.modules.api_client import QueryResult, Source
from evaluation.modules.generation_metrics import (
    build_ragas_dataset,
    create_gemini_judge,
    create_gemini_embeddings,
    _fetch_chunks_from_chroma,
)

from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_recall


TARGET_QUESTION_IDS = ["q002", "q008", "q011", "q022"]
METRICS = ["faithfulness", "answer_relevancy", "context_recall"]

BASELINE_PATH = Path("evaluation/results/baseline-2026-06-06/baseline.json")
DATASET_PATH = Path("evaluation/golden-dataset.json")


def load_target_data():
    """Load the 4 target questions; rebuild QueryResults with REAL excerpts.

    baseline.json stores only chunk_ids (no excerpts), so the excerpt for
    "excerpt mode" is reconstructed as the first 200 chars of the full chunk
    text — matching what the API's Source.excerpt contains.
    """
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    dataset = json.loads(DATASET_PATH.read_text(encoding="utf-8"))

    dataset_by_id = {q["id"]: q for q in dataset["questions"]}
    baseline_by_id = {q["id"]: q for q in baseline["per_question"]}

    # First pass: skeleton results so _fetch_chunks_from_chroma can collect IDs.
    skeleton_results = []
    for qid in TARGET_QUESTION_IDS:
        bl = baseline_by_id[qid]
        skeleton_results.append(QueryResult(
            question=bl["question"],
            answer=bl["answer"],
            sources=[
                Source(chunk_id=cid, score=0.0, excerpt="", metadata={})
                for cid in bl["retrieved_chunk_ids"]
            ],
        ))

    chunks_by_id = _fetch_chunks_from_chroma(skeleton_results)
    if not chunks_by_id:
        print("ERROR: could not fetch any chunks from Chroma — excerpt mode would be empty.")
        print("Is the Chroma docker container running?")
        sys.exit(1)

    questions = []
    query_results = []
    for qid, skeleton in zip(TARGET_QUESTION_IDS, skeleton_results):
        ds = dataset_by_id[qid]
        questions.append(Question(
            id=ds["id"],
            question=ds["question"],
            ground_truth=ds["ground_truth"],
            ground_truth_chunk_ids=ds["ground_truth_chunk_ids"],
            difficulty=ds["difficulty"],
            category=ds["category"],
            notes=ds["notes"],
        ))
        # Rebuild sources with real 200-char excerpts (Source is frozen).
        query_results.append(QueryResult(
            question=skeleton.question,
            answer=skeleton.answer,
            sources=[
                Source(
                    chunk_id=s.chunk_id,
                    score=0.0,
                    excerpt=chunks_by_id.get(s.chunk_id, "")[:200],
                    metadata={},
                )
                for s in skeleton.sources
            ],
        ))

    return questions, query_results


def run_mode(label, query_results, questions, use_full_chunks):
    # Fresh judge + embeddings PER RUN: ragas.evaluate() closes its asyncio
    # event loop on return, and a reused instance's gRPC async client stays
    # bound to the dead loop ("RuntimeError: Event loop is closed" on every
    # job in the second run).
    judge = create_gemini_judge()
    embeddings = create_gemini_embeddings()

    print(f"\n[{label}] use_full_chunks={use_full_chunks} ...")
    start = time.time()
    ds = build_ragas_dataset(query_results, questions, use_full_chunks=use_full_chunks)
    result = evaluate(
        ds,
        metrics=[faithfulness, answer_relevancy, context_recall],
        llm=judge,
        embeddings=embeddings,
    )
    df = result.to_pandas()
    print(f"  ✓ {label} complete in {time.time() - start:.0f}s")
    return df


def main():
    load_dotenv()

    print("=" * 70)
    print("Faithfulness Audit Test — Excerpt vs Full Chunk Text")
    print("=" * 70)

    questions, query_results = load_target_data()
    print(f"\nLoaded {len(questions)} target questions: {[q.id for q in questions]}")
    avg_excerpt_len = sum(
        len(s.excerpt) for r in query_results for s in r.sources
    ) / sum(len(r.sources) for r in query_results)
    print(f"Mean excerpt length: {avg_excerpt_len:.0f} chars")

    excerpt_df = run_mode("Run 1: Excerpt mode", query_results, questions, False)
    full_df = run_mode("Run 2: Full chunk mode", query_results, questions, True)

    # ----- Compare -----
    print("\n" + "=" * 70)
    print("COMPARISON")
    print("=" * 70)

    print(f"\n{'Question':<8} {'Metric':<20} {'Excerpt':>10} {'Full Chunk':>12} {'Δ':>10}")
    print("-" * 65)

    for idx, q in enumerate(questions):
        for metric in METRICS:
            ex_val = excerpt_df.iloc[idx].get(metric, float('nan'))
            full_val = full_df.iloc[idx].get(metric, float('nan'))
            try:
                delta = full_val - ex_val
                print(f"{q.id:<8} {metric:<20} {ex_val:>10.3f} {full_val:>12.3f} {delta:>+10.3f}")
            except (TypeError, ValueError):
                print(f"{q.id:<8} {metric:<20} {ex_val!s:>10} {full_val!s:>12} {'N/A':>10}")

    print(f"\n{'AGGREGATE':<8} {'Metric':<20} {'Excerpt':>10} {'Full Chunk':>12} {'Δ':>10}")
    print("-" * 65)
    for metric in METRICS:
        ex_mean = excerpt_df[metric].mean() if metric in excerpt_df.columns else float('nan')
        full_mean = full_df[metric].mean() if metric in full_df.columns else float('nan')
        try:
            delta = full_mean - ex_mean
            print(f"{'':>8} {metric:<20} {ex_mean:>10.3f} {full_mean:>12.3f} {delta:>+10.3f}")
        except (TypeError, ValueError):
            pass

    print("\n" + "=" * 70)
    print("Done. See above for excerpt → full-chunk impact.")


if __name__ == "__main__":
    main()
