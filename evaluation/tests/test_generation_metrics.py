import os
from unittest.mock import MagicMock, patch

import pytest

from evaluation.modules.generation_metrics import (
    build_ragas_dataset,
    calculate_generation_metrics,
    get_per_question_scores,
    create_gemini_judge,
    create_gemini_embeddings,
    _safe_mean,
    _is_nan,
)
from evaluation.modules.dataset import Question
from evaluation.modules.api_client import QueryResult, Source


# ============================================================
# Fixtures
# ============================================================

def _make_question(qid: str, is_refusal: bool = False) -> Question:
    return Question(
        id=qid,
        question=f"Question {qid}?",
        ground_truth="Expected answer." if not is_refusal else "The sources do not contain...",
        ground_truth_chunk_ids=[] if is_refusal else ["chunk_1"],
        difficulty="edge" if is_refusal else "easy",
        category="edge_case" if is_refusal else "factual_lookup",
        notes="test",
    )


def _make_result(answer: str, num_sources: int = 2) -> QueryResult:
    return QueryResult(
        question="Question?",
        answer=answer,
        sources=[
            Source(
                chunk_id=f"chunk_{i+1}",
                score=0.9 - (i * 0.1),
                excerpt=f"Excerpt text {i+1}.",
                metadata={},
            )
            for i in range(num_sources)
        ],
    )


# ============================================================
# Gemini config tests
# ============================================================

def test_create_gemini_judge_uses_env_key(monkeypatch):
    """create_gemini_judge reads GOOGLE_API_KEY from environment."""
    monkeypatch.setenv("GOOGLE_API_KEY", "fake-key-123")

    with patch('evaluation.modules.generation_metrics.ChatGoogleGenerativeAI') as mock_chat:
        with patch('evaluation.modules.generation_metrics.LangchainLLMWrapper'):
            create_gemini_judge()

            mock_chat.assert_called_once()
            call_kwargs = mock_chat.call_args.kwargs
            assert call_kwargs.get('google_api_key') == 'fake-key-123'
            assert call_kwargs.get('temperature') == 0
            assert call_kwargs.get('model') == 'gemini-2.5-pro'


def test_create_gemini_judge_missing_key_raises(monkeypatch):
    """Missing GOOGLE_API_KEY raises descriptive error."""
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        create_gemini_judge()


def test_create_gemini_embeddings_missing_key_raises(monkeypatch):
    """Missing GOOGLE_API_KEY raises for embeddings too."""
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        create_gemini_embeddings()


# ============================================================
# Dataset conversion tests
# ============================================================

def test_build_ragas_dataset_shape():
    """Conversion produces correct columns and row count."""
    questions = [_make_question("q001"), _make_question("q002")]
    results = [_make_result("Answer 1"), _make_result("Answer 2")]

    dataset = build_ragas_dataset(results, questions)

    assert set(dataset.column_names) == {'question', 'answer', 'contexts', 'ground_truth'}
    assert len(dataset) == 2


def test_build_ragas_dataset_uses_excerpts():
    """Contexts column contains excerpts (not chunk IDs)."""
    questions = [_make_question("q001")]
    results = [_make_result("Answer", num_sources=3)]

    dataset = build_ragas_dataset(results, questions)

    contexts = dataset[0]['contexts']
    assert len(contexts) == 3
    assert "Excerpt text 1." in contexts


def test_build_ragas_dataset_handles_refusal():
    """Refusal questions still convertible; ground_truth contains refusal text."""
    questions = [_make_question("q001", is_refusal=True)]
    results = [_make_result("I cannot answer this from the sources.")]

    dataset = build_ragas_dataset(results, questions)

    assert dataset[0]['ground_truth'].startswith("The sources do not contain")


def test_build_ragas_dataset_length_mismatch_raises():
    """Mismatched lengths fail fast."""
    questions = [_make_question("q001")]
    results = [_make_result("A1"), _make_result("A2")]

    with pytest.raises(ValueError, match="Length mismatch"):
        build_ragas_dataset(results, questions)


# ============================================================
# Aggregate calculation tests (mocked Ragas)
# ============================================================

def _make_mock_ragas_result(scores_per_row: dict):
    """
    Create a mock Ragas result object with .to_pandas() method.
    scores_per_row is a dict like {'faithfulness': [0.8, 0.9, ...]}.
    """
    import pandas as pd
    df = pd.DataFrame(scores_per_row)

    mock_result = MagicMock()
    mock_result.to_pandas.return_value = df
    return mock_result


@patch('evaluation.modules.generation_metrics.evaluate')
def test_calculate_generation_metrics_aggregates_correctly(mock_evaluate):
    """Aggregate means computed correctly across all questions."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.8, 0.9, 0.7],
        'answer_relevancy': [0.9, 0.85, 0.95],
        'context_precision': [0.7, 0.8, 0.6],
        'context_recall': [0.75, 0.85, 0.65],
        'answer_correctness': [0.8, 0.85, 0.75],
    })

    questions = [_make_question(f"q00{i}") for i in range(1, 4)]
    results = [_make_result(f"A{i}") for i in range(1, 4)]

    scores = calculate_generation_metrics(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

    assert scores.faithfulness == pytest.approx(0.8)
    assert scores.answer_relevancy == pytest.approx(0.9)
    assert scores.context_precision == pytest.approx(0.7)
    assert scores.context_recall == pytest.approx(0.75)
    assert scores.answer_correctness == pytest.approx(0.8)
    assert scores.questions_total == 3
    assert scores.questions_evaluated_for_context == 3
    assert scores.questions_evaluated_for_faithfulness == 3


@patch('evaluation.modules.generation_metrics.evaluate')
def test_calculate_generation_metrics_handles_nan_in_context_metrics(mock_evaluate):
    """Refusal questions producing NaN for context_precision/recall don't break aggregation."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.8, 0.9, 0.7],  # all valid
        'answer_relevancy': [0.9, 0.85, 0.95],
        'context_precision': [0.7, float('nan'), 0.6],  # one NaN
        'context_recall': [0.75, float('nan'), 0.65],
        'answer_correctness': [0.8, 0.85, 0.75],
    })

    questions = [
        _make_question("q001"),
        _make_question("q002", is_refusal=True),
        _make_question("q003"),
    ]
    results = [_make_result(f"A{i}") for i in range(3)]

    scores = calculate_generation_metrics(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

    # Faithfulness includes all 3
    assert scores.faithfulness == pytest.approx(0.8)
    # Context metrics exclude the NaN (mean of 0.7 and 0.6)
    assert scores.context_precision == pytest.approx(0.65)
    assert scores.context_recall == pytest.approx(0.7)
    assert scores.questions_evaluated_for_context == 2
    assert scores.questions_evaluated_for_faithfulness == 3


@patch('evaluation.modules.generation_metrics.evaluate')
def test_calculate_generation_metrics_all_nan_returns_none(mock_evaluate):
    """If every row's context_precision is NaN, the metric should be None."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.8, 0.9],
        'answer_relevancy': [0.9, 0.85],
        'context_precision': [float('nan'), float('nan')],
        'context_recall': [float('nan'), float('nan')],
        'answer_correctness': [0.8, 0.85],
    })

    questions = [_make_question("q001", is_refusal=True), _make_question("q002", is_refusal=True)]
    results = [_make_result(f"A{i}") for i in range(2)]

    scores = calculate_generation_metrics(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

    assert scores.context_precision is None
    assert scores.context_recall is None
    assert scores.faithfulness is not None  # still computable


# ============================================================
# Per-question score tests
# ============================================================

@patch('evaluation.modules.generation_metrics.evaluate')
def test_get_per_question_scores_returns_one_per_question(mock_evaluate):
    """Per-question extraction matches dataset order."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.9, 0.5],
        'answer_relevancy': [0.85, 0.7],
        'context_precision': [0.8, 0.6],
        'context_recall': [0.9, 0.7],
        'answer_correctness': [0.85, 0.65],
    })

    questions = [_make_question("q001"), _make_question("q002")]
    results = [_make_result("A1"), _make_result("A2")]

    per_q = get_per_question_scores(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

    assert len(per_q) == 2
    assert per_q[0].question_id == "q001"
    assert per_q[0].faithfulness == pytest.approx(0.9)
    assert per_q[1].question_id == "q002"
    assert per_q[1].faithfulness == pytest.approx(0.5)


@patch('evaluation.modules.generation_metrics.evaluate')
def test_get_per_question_scores_handles_nan_per_question(mock_evaluate):
    """NaN in a per-question score becomes None."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.9, 0.5],
        'answer_relevancy': [0.85, 0.7],
        'context_precision': [0.8, float('nan')],
        'context_recall': [0.9, float('nan')],
        'answer_correctness': [0.85, 0.65],
    })

    questions = [_make_question("q001"), _make_question("q002", is_refusal=True)]
    results = [_make_result("A1"), _make_result("A2")]

    per_q = get_per_question_scores(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

    assert per_q[1].context_precision is None
    assert per_q[1].context_recall is None
    assert per_q[1].faithfulness == pytest.approx(0.5)


# ============================================================
# Helper function tests
# ============================================================

def test_safe_mean_skips_nan():
    assert _safe_mean([1.0, float('nan'), 3.0]) == pytest.approx(2.0)


def test_safe_mean_all_nan_returns_none():
    assert _safe_mean([float('nan'), float('nan')]) is None


def test_safe_mean_empty_returns_none():
    assert _safe_mean([]) is None


def test_is_nan_for_float_nan():
    assert _is_nan(float('nan')) is True


def test_is_nan_for_regular_number():
    assert _is_nan(0.5) is False


def test_is_nan_for_string():
    assert _is_nan("hello") is False


# ============================================================
# Optional smoke test (real Ragas + Gemini call)
# ============================================================

@pytest.mark.slow
def test_smoke_real_ragas_with_gemini():
    """
    Real end-to-end test with actual Ragas + Gemini calls.

    Skipped by default. Run with: pytest --slow
    Requires GOOGLE_API_KEY in environment.
    Takes ~30-60 seconds, makes ~10-15 LLM calls.
    """
    if not os.environ.get("GOOGLE_API_KEY"):
        pytest.skip("GOOGLE_API_KEY not set")

    questions = [
        Question(
            id="smoke_q001",
            question="What is the capital of France?",
            ground_truth="Paris is the capital of France.",
            ground_truth_chunk_ids=["smoke_chunk"],
            difficulty="easy",
            category="factual_lookup",
            notes="smoke test",
        ),
    ]
    results = [
        QueryResult(
            question="What is the capital of France?",
            answer="Paris is the capital of France.",
            sources=[
                Source(
                    chunk_id="smoke_chunk",
                    score=0.95,
                    excerpt="Paris is the capital of France, located in the north.",
                    metadata={},
                ),
            ],
        ),
    ]

    scores = calculate_generation_metrics(results, questions)

    # Sanity checks: scores should be in valid range
    assert scores.faithfulness is not None
    assert 0.0 <= scores.faithfulness <= 1.0
    assert scores.questions_total == 1
