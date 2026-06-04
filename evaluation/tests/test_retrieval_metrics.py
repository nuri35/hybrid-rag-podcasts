import pytest

from evaluation.modules.retrieval_metrics import (
    mrr,
    hit_at_k,
    precision_at_k,
    recall_at_k,
    compute_per_question_scores,
    aggregate_scores,
    RetrievalScores,
)


# ============================================================
# MRR Tests
# ============================================================

def test_mrr_perfect_top_1():
    """Relevant chunk in position 1 → MRR = 1.0."""
    assert mrr(['a', 'b', 'c'], ['a']) == 1.0


def test_mrr_relevant_at_position_2():
    """Relevant chunk in position 2 → MRR = 0.5."""
    assert mrr(['a', 'b', 'c'], ['b']) == 0.5


def test_mrr_relevant_at_position_5():
    """Relevant chunk at position 5 → MRR = 0.2."""
    assert mrr(['a', 'b', 'c', 'd', 'e'], ['e']) == 0.2


def test_mrr_no_relevant():
    """No relevant chunks retrieved → MRR = 0."""
    assert mrr(['a', 'b', 'c'], ['x']) == 0.0


def test_mrr_first_relevant_counts():
    """When multiple relevant chunks exist, MRR uses the first one's rank."""
    assert mrr(['a', 'b', 'c'], ['c', 'b']) == 0.5  # b is at rank 2


def test_mrr_empty_retrieved():
    """Empty retrieved list with relevant ground truth → MRR = 0."""
    assert mrr([], ['a']) == 0.0


def test_mrr_empty_ground_truth_raises():
    """Empty ground truth raises (refusal questions handled separately)."""
    with pytest.raises(ValueError, match="undefined for empty"):
        mrr(['a', 'b'], [])


# ============================================================
# Hit@K Tests
# ============================================================

def test_hit_at_k_found_in_top_k():
    """Relevant chunk in top-K → Hit@K = 1."""
    assert hit_at_k(['a', 'b', 'c', 'd', 'e'], ['c'], k=5) == 1.0


def test_hit_at_k_not_in_top_k():
    """Relevant chunk outside top-K → Hit@K = 0."""
    assert hit_at_k(['a', 'b', 'c', 'd', 'e', 'f'], ['f'], k=5) == 0.0


def test_hit_at_k_default_k_is_5():
    """Default k is 5."""
    assert hit_at_k(['a', 'b', 'c', 'd', 'e'], ['e']) == 1.0
    assert hit_at_k(['a', 'b', 'c', 'd', 'e', 'f'], ['f']) == 0.0


def test_hit_at_k_smaller_k():
    """Hit@3 misses what Hit@5 catches if relevant is at position 4-5."""
    retrieved = ['a', 'b', 'c', 'd', 'e']
    assert hit_at_k(retrieved, ['d'], k=3) == 0.0  # d is at position 4
    assert hit_at_k(retrieved, ['d'], k=5) == 1.0


def test_hit_at_k_zero_k_raises():
    """k must be positive."""
    with pytest.raises(ValueError, match="positive"):
        hit_at_k(['a'], ['a'], k=0)


def test_hit_at_k_empty_ground_truth_raises():
    """Empty ground truth raises."""
    with pytest.raises(ValueError, match="undefined"):
        hit_at_k(['a'], [], k=5)


# ============================================================
# Precision@K Tests
# ============================================================

def test_precision_at_k_basic():
    """2 out of 5 in top-K are relevant → Precision@5 = 0.4."""
    assert precision_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], k=5) == 0.4


def test_precision_at_k_all_relevant():
    """All top-K relevant → Precision@K = 1.0."""
    assert precision_at_k(['a', 'b', 'c'], ['a', 'b', 'c'], k=3) == 1.0


def test_precision_at_k_none_relevant():
    """None relevant → Precision@K = 0.0."""
    assert precision_at_k(['a', 'b', 'c'], ['x', 'y'], k=3) == 0.0


def test_precision_at_k_fewer_retrieved_than_k():
    """If retrieved < k, denominator is still k (penalty for under-retrieval)."""
    # Only 3 retrieved, all relevant, but k=5 → precision = 3/5 = 0.6
    assert precision_at_k(['a', 'b', 'c'], ['a', 'b', 'c'], k=5) == 0.6


def test_precision_at_k_empty_ground_truth_raises():
    """Empty ground truth raises."""
    with pytest.raises(ValueError, match="undefined"):
        precision_at_k(['a'], [], k=5)


# ============================================================
# Recall@K Tests
# ============================================================

def test_recall_at_k_perfect():
    """All ground truth retrieved → Recall@K = 1.0."""
    assert recall_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], k=5) == 1.0


def test_recall_at_k_partial():
    """2 of 3 ground truth retrieved → Recall@K = 0.667."""
    assert recall_at_k(['a', 'b', 'c', 'd', 'e'], ['a', 'c', 'f'], k=5) == pytest.approx(2 / 3)


def test_recall_at_k_none_retrieved():
    """No ground truth in top-K → Recall@K = 0."""
    assert recall_at_k(['x', 'y', 'z'], ['a', 'b'], k=5) == 0.0


def test_recall_at_k_smaller_k_limits_recall():
    """Small k can cap recall even with relevant chunks deeper in list."""
    retrieved = ['a', 'b', 'c', 'd', 'e']
    # ground truth: a, d, e — k=3 only catches 'a'
    assert recall_at_k(retrieved, ['a', 'd', 'e'], k=3) == pytest.approx(1 / 3)
    assert recall_at_k(retrieved, ['a', 'd', 'e'], k=5) == 1.0


def test_recall_at_k_empty_ground_truth_raises():
    """Empty ground truth raises."""
    with pytest.raises(ValueError, match="undefined"):
        recall_at_k(['a'], [], k=5)


# ============================================================
# Per-Question Scores
# ============================================================

def test_compute_per_question_scores_normal():
    """All 4 metrics computed for a normal question."""
    scores = compute_per_question_scores(
        retrieved_ids=['a', 'b', 'c', 'd', 'e'],
        ground_truth_ids=['b', 'd'],
        k=5,
    )
    assert scores.mrr == 0.5  # b is at position 2
    assert scores.hit_at_k == 1.0
    assert scores.precision_at_k == 0.4  # 2 out of 5
    assert scores.recall_at_k == 1.0  # both found
    assert scores.k == 5


def test_compute_per_question_scores_refusal_returns_none():
    """Refusal questions (empty ground_truth) → all metrics None."""
    scores = compute_per_question_scores(
        retrieved_ids=['a', 'b'],
        ground_truth_ids=[],
        k=5,
    )
    assert scores.mrr is None
    assert scores.hit_at_k is None
    assert scores.precision_at_k is None
    assert scores.recall_at_k is None


# ============================================================
# Aggregation
# ============================================================

def test_aggregate_scores_skips_refusal():
    """Refusal questions excluded from aggregation."""
    per_q = [
        RetrievalScores(mrr=1.0, hit_at_k=1.0, precision_at_k=0.4, recall_at_k=1.0, k=5),
        RetrievalScores(mrr=None, hit_at_k=None, precision_at_k=None, recall_at_k=None, k=5),
        RetrievalScores(mrr=0.5, hit_at_k=1.0, precision_at_k=0.2, recall_at_k=0.5, k=5),
    ]

    agg = aggregate_scores(per_q)

    assert agg.questions_evaluated == 2
    assert agg.questions_skipped == 1
    assert agg.mrr == 0.75  # (1.0 + 0.5) / 2
    assert agg.hit_at_k == 1.0  # (1.0 + 1.0) / 2
    assert agg.precision_at_k == pytest.approx(0.3)  # (0.4 + 0.2) / 2
    assert agg.recall_at_k == 0.75  # (1.0 + 0.5) / 2


def test_aggregate_all_refusal_raises():
    """If every question is refusal-type, aggregation has nothing to compute."""
    per_q = [
        RetrievalScores(mrr=None, hit_at_k=None, precision_at_k=None, recall_at_k=None, k=5),
        RetrievalScores(mrr=None, hit_at_k=None, precision_at_k=None, recall_at_k=None, k=5),
    ]

    with pytest.raises(ValueError, match="No valid scores"):
        aggregate_scores(per_q)


def test_aggregate_inconsistent_k_raises():
    """Mixing different k values is a programmer error."""
    per_q = [
        RetrievalScores(mrr=1.0, hit_at_k=1.0, precision_at_k=0.5, recall_at_k=1.0, k=5),
        RetrievalScores(mrr=0.5, hit_at_k=1.0, precision_at_k=0.5, recall_at_k=0.5, k=10),
    ]

    with pytest.raises(ValueError, match="Inconsistent k"):
        aggregate_scores(per_q)
