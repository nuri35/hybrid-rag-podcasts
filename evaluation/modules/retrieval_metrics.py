"""Custom retrieval evaluation metrics: MRR, Hit@K, Precision@K, Recall@K.

Pure Python, dependency-free (built-ins only). Every function is
deterministic and side-effect free. Refusal questions (empty
ground_truth_chunk_ids) have no retrieval ground truth to score against:
`compute_per_question_scores` returns None metrics for them and
`aggregate_scores` skips them, tracking the count in `questions_skipped`.
"""

from dataclasses import dataclass
from typing import List, Optional


# Default top-K for our system (Phase 1.5 retrieval default)
DEFAULT_K = 5


@dataclass(frozen=True)
class RetrievalScores:
    """Per-question retrieval scores. None means metric not applicable (e.g., refusal questions)."""
    mrr: Optional[float]
    hit_at_k: Optional[float]
    precision_at_k: Optional[float]
    recall_at_k: Optional[float]
    k: int


@dataclass(frozen=True)
class AggregateRetrievalScores:
    """Aggregated retrieval scores across multiple questions."""
    mrr: float
    hit_at_k: float
    precision_at_k: float
    recall_at_k: float
    k: int
    questions_evaluated: int  # excludes refusal questions
    questions_skipped: int  # refusal questions skipped


def mrr(retrieved_ids: List[str], ground_truth_ids: List[str]) -> float:
    """
    Mean Reciprocal Rank for a single query.

    Returns 1 / (rank of first relevant chunk), or 0 if no relevant chunk found.
    Rank is 1-indexed.

    Args:
        retrieved_ids: ordered list of chunk IDs returned by retrieval
        ground_truth_ids: set of chunk IDs marked as relevant in golden dataset

    Returns:
        Float in [0, 1]. Higher is better.

    Examples:
        >>> mrr(['a', 'b', 'c'], ['b'])
        0.5
        >>> mrr(['a', 'b', 'c'], ['a'])
        1.0
        >>> mrr(['a', 'b', 'c'], ['x'])
        0.0
    """
    if not ground_truth_ids:
        raise ValueError("mrr undefined for empty ground_truth_ids; check is_refusal first")

    gt_set = set(ground_truth_ids)
    for i, chunk_id in enumerate(retrieved_ids):
        if chunk_id in gt_set:
            return 1.0 / (i + 1)
    return 0.0


def hit_at_k(retrieved_ids: List[str], ground_truth_ids: List[str], k: int = DEFAULT_K) -> float:
    """
    Hit@K: 1 if at least one relevant chunk appears in top-K, else 0.

    Returns:
        1.0 or 0.0 (binary metric).

    Examples:
        >>> hit_at_k(['a', 'b', 'c', 'd', 'e'], ['c'], k=5)
        1.0
        >>> hit_at_k(['a', 'b', 'c', 'd', 'e'], ['x'], k=5)
        0.0
        >>> hit_at_k(['a', 'b', 'c', 'd', 'e'], ['e'], k=3)  # outside top-3
        0.0
    """
    if not ground_truth_ids:
        raise ValueError("hit_at_k undefined for empty ground_truth_ids")
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")

    top_k = retrieved_ids[:k]
    gt_set = set(ground_truth_ids)
    return 1.0 if any(c in gt_set for c in top_k) else 0.0


def precision_at_k(retrieved_ids: List[str], ground_truth_ids: List[str], k: int = DEFAULT_K) -> float:
    """
    Precision@K: fraction of top-K that are relevant.

    Returns:
        Float in [0, 1]. Higher = less noise in retrieval.

    Examples:
        >>> precision_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], k=5)
        0.4
        >>> precision_at_k(['a', 'b', 'c'], ['a', 'b', 'c'], k=5)  # only 3 retrieved
        0.6
    """
    if not ground_truth_ids:
        raise ValueError("precision_at_k undefined for empty ground_truth_ids")
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")

    top_k = retrieved_ids[:k]
    gt_set = set(ground_truth_ids)
    relevant_in_top_k = sum(1 for c in top_k if c in gt_set)
    return relevant_in_top_k / k


def recall_at_k(retrieved_ids: List[str], ground_truth_ids: List[str], k: int = DEFAULT_K) -> float:
    """
    Recall@K: fraction of all relevant chunks that appear in top-K.

    Returns:
        Float in [0, 1]. Higher = better completeness.

    Examples:
        >>> recall_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], k=5)
        1.0
        >>> round(recall_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c', 'f'], k=5), 4)
        0.6667
        >>> recall_at_k(['a', 'b'], ['a', 'c'], k=5)  # only 2 retrieved
        0.5
    """
    if not ground_truth_ids:
        raise ValueError("recall_at_k undefined for empty ground_truth_ids")
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")

    top_k = retrieved_ids[:k]
    gt_set = set(ground_truth_ids)
    relevant_in_top_k = sum(1 for c in top_k if c in gt_set)
    return relevant_in_top_k / len(gt_set)


def compute_per_question_scores(
    retrieved_ids: List[str],
    ground_truth_ids: List[str],
    k: int = DEFAULT_K,
) -> RetrievalScores:
    """
    Compute all 4 retrieval metrics for a single question.

    Returns RetrievalScores with None values if ground_truth_ids is empty
    (refusal questions don't have retrieval ground truth to score against).
    """
    if not ground_truth_ids:
        return RetrievalScores(
            mrr=None,
            hit_at_k=None,
            precision_at_k=None,
            recall_at_k=None,
            k=k,
        )

    return RetrievalScores(
        mrr=mrr(retrieved_ids, ground_truth_ids),
        hit_at_k=hit_at_k(retrieved_ids, ground_truth_ids, k),
        precision_at_k=precision_at_k(retrieved_ids, ground_truth_ids, k),
        recall_at_k=recall_at_k(retrieved_ids, ground_truth_ids, k),
        k=k,
    )


def aggregate_scores(
    per_question_scores: List[RetrievalScores],
) -> AggregateRetrievalScores:
    """
    Aggregate per-question scores into mean values across the dataset.

    Skips questions where metrics are None (refusal questions).
    Raises ValueError if all questions were skipped (no metrics to aggregate).
    """
    valid_scores = [s for s in per_question_scores if s.mrr is not None]
    skipped = len(per_question_scores) - len(valid_scores)

    if not valid_scores:
        raise ValueError("No valid scores to aggregate (all questions were refusal-type)")

    n = len(valid_scores)
    k = valid_scores[0].k

    # All valid scores should have the same k (sanity check)
    if not all(s.k == k for s in valid_scores):
        raise ValueError("Inconsistent k values across scores")

    return AggregateRetrievalScores(
        mrr=sum(s.mrr for s in valid_scores) / n,
        hit_at_k=sum(s.hit_at_k for s in valid_scores) / n,
        precision_at_k=sum(s.precision_at_k for s in valid_scores) / n,
        recall_at_k=sum(s.recall_at_k for s in valid_scores) / n,
        k=k,
        questions_evaluated=n,
        questions_skipped=skipped,
    )
