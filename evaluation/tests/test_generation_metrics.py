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
# Phase 4 — substantive (non-refusal) split + generation reads expanded sources
# ============================================================

def _mock_ragas(faith, rel, ctx):
    """A mock Ragas result whose to_pandas().to_dict(orient='list') yields the
    given per-row score lists."""
    df = MagicMock()
    df.to_dict.return_value = {
        'faithfulness': faith,
        'answer_relevancy': rel,
        'context_recall': ctx,
    }
    result = MagicMock()
    result.to_pandas.return_value = df
    return result


def test_substantive_split_excludes_refusals():
    """2 refusals + 3 substantive → substantive means exclude the refusals;
    refusal_count=2; raw mean still spans all rows."""
    nan = float('nan')
    # rows 0-2 substantive, rows 3-4 refusals (by ANSWER text)
    query_results = [
        _make_result("Answer A [Source 1]."),
        _make_result("Answer B [Source 2]."),
        _make_result("Answer C [Source 1]."),
        _make_result("I cannot answer this question from the provided sources."),
        _make_result("The sources do not contain information about that."),
    ]
    questions = [
        _make_question("q001"), _make_question("q002"), _make_question("q003"),
        _make_question("q004", is_refusal=True), _make_question("q005", is_refusal=True),
    ]
    mock_result = _mock_ragas(
        faith=[1.0, 0.8, 0.9, 0.0, 1.0],          # refusals scored 0.0/1.0 erratically
        rel=[0.9, 0.85, 0.8, 0.0, 0.0],
        ctx=[0.9, 0.8, 0.85, nan, nan],
    )

    with patch('evaluation.modules.generation_metrics.evaluate', return_value=mock_result), \
         patch('evaluation.modules.generation_metrics._fetch_chunks_from_chroma', return_value={}):
        scores = calculate_generation_metrics(
            query_results, questions, judge_llm=MagicMock(), embeddings=MagicMock())

    assert scores.refusal_count == 2
    assert set(scores.refusal_question_ids) == {"q004", "q005"}
    # substantive = mean of the 3 non-refusal rows
    assert scores.substantive_faithfulness == pytest.approx((1.0 + 0.8 + 0.9) / 3)
    assert scores.substantive_answer_relevancy == pytest.approx((0.9 + 0.85 + 0.8) / 3)
    # raw still spans all 5 rows (refusal deflation visible)
    assert scores.faithfulness == pytest.approx((1.0 + 0.8 + 0.9 + 0.0 + 1.0) / 5)


def test_build_ragas_dataset_reads_expanded_sources_not_fused():
    """Generation context comes from `sources` (expanded), unaffected by the
    fused_top_k_ids field (which is only for rank metrics)."""
    qr = QueryResult(
        question="q?", answer="a",
        sources=[Source(chunk_id="c1", score=0.9, excerpt="EXPANDED EXCERPT", metadata={})],
        fused_top_k_ids=["c1", "c2", "c3"],   # different/larger — must be ignored here
    )
    q = _make_question("q001")
    with patch('evaluation.modules.generation_metrics._fetch_chunks_from_chroma', return_value={}):
        ds = build_ragas_dataset([qr], [q])
    # one context, sourced from the expanded list's excerpt
    assert ds['contexts'][0] == ["EXPANDED EXCERPT"]


# ============================================================
# Gemini config tests
# ============================================================

def test_create_gemini_judge_uses_env_key(monkeypatch):
    """create_gemini_judge reads GOOGLE_API_KEY from environment."""
    monkeypatch.setenv("GOOGLE_API_KEY", "fake-key-123")

    with patch('evaluation.modules.generation_metrics.RagasCompatibleChatGoogleGenerativeAI') as mock_chat:
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
# Ragas-compatibility wrapper tests
# ============================================================
# Ragas always passes `temperature` (and sometimes `n`) as per-call kwargs;
# langchain-google-genai 2.0.x forwards unknown kwargs to the raw gRPC client,
# which rejects them with TypeError. The wrapper must strip them.

def test_wrapper_strips_temperature_kwarg_sync():
    """_generate drops temperature/n before delegating to the parent class."""
    import asyncio
    from langchain_google_genai import ChatGoogleGenerativeAI
    from evaluation.modules.generation_metrics import RagasCompatibleChatGoogleGenerativeAI

    model = RagasCompatibleChatGoogleGenerativeAI(
        model="gemini-2.5-pro", temperature=0, google_api_key="fake-key",
    )

    with patch.object(ChatGoogleGenerativeAI, "_generate", return_value="result") as mock_gen:
        out = model._generate([], temperature=1e-8, n=3, custom_kwarg="keep")

    assert out == "result"
    forwarded = mock_gen.call_args.kwargs
    assert "temperature" not in forwarded
    assert "n" not in forwarded
    assert forwarded.get("custom_kwarg") == "keep"  # only known-bad kwargs stripped


def test_wrapper_strips_temperature_kwarg_async():
    """_agenerate drops temperature/n before delegating to the parent class."""
    import asyncio
    from unittest.mock import AsyncMock
    from langchain_google_genai import ChatGoogleGenerativeAI
    from evaluation.modules.generation_metrics import RagasCompatibleChatGoogleGenerativeAI

    model = RagasCompatibleChatGoogleGenerativeAI(
        model="gemini-2.5-pro", temperature=0, google_api_key="fake-key",
    )

    with patch.object(ChatGoogleGenerativeAI, "_agenerate", new=AsyncMock(return_value="result")) as mock_agen:
        out = asyncio.run(model._agenerate([], temperature=1e-8, n=3))

    assert out == "result"
    forwarded = mock_agen.call_args.kwargs
    assert "temperature" not in forwarded
    assert "n" not in forwarded


# ============================================================
# Gemini finish_reason parser tests
# ============================================================
# Ragas's default is_finished compares finish_reason == "stop" (lowercase);
# Gemini reports "STOP" (uppercase) → LLMDidNotFinishException on every job.

def _llm_result_with_finish_reason(finish_reason):
    """Build a minimal LLMResult carrying the given finish_reason."""
    from langchain_core.outputs import LLMResult, ChatGeneration
    from langchain_core.messages import AIMessage

    generation = ChatGeneration(
        message=AIMessage(content="OK"),
        generation_info=None if finish_reason is None else {"finish_reason": finish_reason},
    )
    return LLMResult(generations=[[generation]])


def test_finished_parser_accepts_uppercase_stop():
    """Gemini's 'STOP' must count as finished."""
    from evaluation.modules.generation_metrics import gemini_is_finished_parser

    assert gemini_is_finished_parser(_llm_result_with_finish_reason("STOP")) is True


def test_finished_parser_accepts_lowercase_stop():
    """OpenAI-style 'stop' also counts as finished."""
    from evaluation.modules.generation_metrics import gemini_is_finished_parser

    assert gemini_is_finished_parser(_llm_result_with_finish_reason("stop")) is True


def test_finished_parser_rejects_max_tokens():
    """A truncated response (MAX_TOKENS) is NOT finished."""
    from evaluation.modules.generation_metrics import gemini_is_finished_parser

    assert gemini_is_finished_parser(_llm_result_with_finish_reason("MAX_TOKENS")) is False


def test_finished_parser_defaults_true_when_no_signal():
    """No finish_reason anywhere → assume finished (mirrors Ragas default)."""
    from evaluation.modules.generation_metrics import gemini_is_finished_parser

    assert gemini_is_finished_parser(_llm_result_with_finish_reason(None)) is True


def test_create_gemini_judge_wires_finished_parser(monkeypatch):
    """The judge wrapper must receive the Gemini-aware is_finished_parser."""
    monkeypatch.setenv("GOOGLE_API_KEY", "fake-key-123")

    from evaluation.modules.generation_metrics import gemini_is_finished_parser

    with patch('evaluation.modules.generation_metrics.RagasCompatibleChatGoogleGenerativeAI'):
        with patch('evaluation.modules.generation_metrics.LangchainLLMWrapper') as mock_wrapper:
            create_gemini_judge()

    assert mock_wrapper.call_args.kwargs.get('is_finished_parser') is gemini_is_finished_parser


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
        'context_recall': [0.75, 0.85, 0.65],
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
    assert scores.context_recall == pytest.approx(0.75)
    assert scores.questions_total == 3
    assert scores.questions_evaluated_for_context == 3
    assert scores.questions_evaluated_for_faithfulness == 3


@patch('evaluation.modules.generation_metrics.evaluate')
def test_calculate_generation_metrics_handles_nan_in_context_metrics(mock_evaluate):
    """Refusal questions producing NaN for context_recall don't break aggregation."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.8, 0.9, 0.7],  # all valid
        'answer_relevancy': [0.9, 0.85, 0.95],
        'context_recall': [0.75, float('nan'), 0.65],  # one NaN
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
    # Context recall excludes the NaN (mean of 0.75 and 0.65)
    assert scores.context_recall == pytest.approx(0.7)
    assert scores.questions_evaluated_for_context == 2
    assert scores.questions_evaluated_for_faithfulness == 3


@patch('evaluation.modules.generation_metrics.evaluate')
def test_calculate_generation_metrics_all_nan_returns_none(mock_evaluate):
    """If every row's context_recall is NaN, the metric should be None."""
    mock_evaluate.return_value = _make_mock_ragas_result({
        'faithfulness': [0.8, 0.9],
        'answer_relevancy': [0.9, 0.85],
        'context_recall': [float('nan'), float('nan')],
    })

    questions = [_make_question("q001", is_refusal=True), _make_question("q002", is_refusal=True)]
    results = [_make_result(f"A{i}") for i in range(2)]

    scores = calculate_generation_metrics(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

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
        'context_recall': [0.9, 0.7],
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
        'context_recall': [0.9, float('nan')],
    })

    questions = [_make_question("q001"), _make_question("q002", is_refusal=True)]
    results = [_make_result("A1"), _make_result("A2")]

    per_q = get_per_question_scores(
        results, questions,
        judge_llm=MagicMock(),
        embeddings=MagicMock(),
    )

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
