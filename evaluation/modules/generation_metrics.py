"""
Generation evaluation metrics using Ragas with Gemini 2.5 Pro as LLM-as-judge.

Provides:
- Gemini LLM + embeddings configuration for Ragas
- Dataset conversion from our QueryResult/Question to HuggingFace Dataset
- Aggregated and per-question generation scores
- Graceful NaN handling for refusal questions (empty ground_truth_chunk_ids)
"""

import math
import os
from dataclasses import dataclass
from typing import Any, List, Optional

# Ragas + LangChain Gemini integration
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import (
    faithfulness,
    answer_relevancy,
    context_precision,
    context_recall,
    answer_correctness,
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from langchain_google_genai import (
    ChatGoogleGenerativeAI,
    GoogleGenerativeAIEmbeddings,
)

from evaluation.modules.api_client import QueryResult
from evaluation.modules.dataset import Question


GEMINI_JUDGE_MODEL = "gemini-2.5-pro"
# text-embedding-004 was retired from the Generative Language API (404 on
# v1beta embedContent as of 2026-06-05; absent from ListModels). The judge's
# embeddings are independent of the production Chroma vector space (they only
# score answer_relevancy/answer_correctness similarity), so switching models
# here does NOT require re-ingestion.
GEMINI_EMBEDDING_MODEL = "models/gemini-embedding-001"
GEMINI_JUDGE_TEMPERATURE = 0  # deterministic judgment

# Ragas's LangchainLLMWrapper ALWAYS forwards these as per-call kwargs to
# generate_prompt/agenerate_prompt (ragas 0.2.6 llms/base.py); langchain-google-genai
# (2.0.x incl. 2.0.11) relays unknown kwargs straight to the raw gRPC client,
# whose generate_content() rejects them with TypeError. The judge temperature is
# already fixed at construction (GEMINI_JUDGE_TEMPERATURE), so dropping the
# per-call kwarg is semantically a no-op.
_RAGAS_UNSUPPORTED_KWARGS = ("temperature", "n")


class RagasCompatibleChatGoogleGenerativeAI(ChatGoogleGenerativeAI):
    """ChatGoogleGenerativeAI that strips per-call kwargs Ragas passes but the
    Gemini gRPC client rejects. See _RAGAS_UNSUPPORTED_KWARGS above."""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        for key in _RAGAS_UNSUPPORTED_KWARGS:
            kwargs.pop(key, None)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        for key in _RAGAS_UNSUPPORTED_KWARGS:
            kwargs.pop(key, None)
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


# ============================================================
# Dataclasses
# ============================================================

@dataclass(frozen=True)
class GenerationScores:
    """
    Aggregated generation scores across the dataset.

    None values mean the metric couldn't be aggregated meaningfully
    (e.g., context_precision when most questions are refusal-type).
    """
    faithfulness: Optional[float]
    answer_relevancy: Optional[float]
    context_precision: Optional[float]
    context_recall: Optional[float]
    answer_correctness: Optional[float]

    questions_total: int
    questions_evaluated_for_context: int  # excludes refusal questions
    questions_evaluated_for_faithfulness: int  # all with non-empty answers


@dataclass(frozen=True)
class PerQuestionGenerationScore:
    """Per-question Ragas scores, used by orchestrator for failure analysis."""
    question_id: str
    faithfulness: Optional[float]
    answer_relevancy: Optional[float]
    context_precision: Optional[float]
    context_recall: Optional[float]
    answer_correctness: Optional[float]


# ============================================================
# Gemini LLM-as-Judge Configuration
# ============================================================

def gemini_is_finished_parser(response: Any) -> bool:
    """
    Case-insensitive finish_reason check for Gemini responses.

    Ragas's default is_finished compares finish_reason == "stop" (lowercase,
    OpenAI convention), but Gemini reports "STOP" (uppercase) — so every
    response is treated as unfinished and Ragas raises LLMDidNotFinishException
    on all jobs (see ragas issue #1548). Passing this parser to
    LangchainLLMWrapper restores correct completion detection.
    """
    is_finished_list = []
    for g in response.flatten():
        resp = g.generations[0][0]

        finish_reason = None
        if resp.generation_info is not None:
            finish_reason = resp.generation_info.get("finish_reason")
        elif getattr(resp, "message", None) is not None:
            finish_reason = resp.message.response_metadata.get("finish_reason")

        if finish_reason is None:
            # Mirror Ragas's default: no signal → assume finished
            is_finished_list.append(True)
        else:
            is_finished_list.append(str(finish_reason).lower() == "stop")

    return all(is_finished_list)


def create_gemini_judge() -> LangchainLLMWrapper:
    """
    Create the Gemini-based LLM judge for Ragas evaluation.

    Reads GOOGLE_API_KEY from environment. Temperature=0 for deterministic judgment.

    Raises:
        ValueError: if GOOGLE_API_KEY is not set in the environment.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError(
            "GOOGLE_API_KEY environment variable is required for Ragas evaluation. "
            "Set it in your .env file or shell environment."
        )

    chat_model = RagasCompatibleChatGoogleGenerativeAI(
        model=GEMINI_JUDGE_MODEL,
        temperature=GEMINI_JUDGE_TEMPERATURE,
        google_api_key=api_key,
    )
    return LangchainLLMWrapper(chat_model, is_finished_parser=gemini_is_finished_parser)


def create_gemini_embeddings() -> LangchainEmbeddingsWrapper:
    """
    Create the Gemini embeddings model for similarity-based Ragas metrics
    (answer_relevancy, answer_correctness).

    Raises:
        ValueError: if GOOGLE_API_KEY is not set.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError(
            "GOOGLE_API_KEY environment variable is required for embeddings."
        )

    embeddings_model = GoogleGenerativeAIEmbeddings(
        model=GEMINI_EMBEDDING_MODEL,
        google_api_key=api_key,
    )
    return LangchainEmbeddingsWrapper(embeddings_model)


# ============================================================
# Dataset Conversion
# ============================================================

def build_ragas_dataset(
    query_results: List[QueryResult],
    questions: List[Question],
) -> Dataset:
    """
    Convert our QueryResult + Question pairs into a HuggingFace Dataset
    in the format Ragas requires.

    Ragas expects these columns:
    - question: str
    - answer: str (the LLM's generated answer)
    - contexts: List[str] (retrieved chunk texts)
    - ground_truth: str (expected answer from golden dataset)

    Note: contexts uses Source.excerpt (200-char snippets). If faithfulness
    scores are unexpectedly low in baseline, consider switching to full
    chunk text (would require API changes — out of scope for this sprint).

    Args:
        query_results: API responses, ordered to match questions.
        questions: Golden dataset entries.

    Returns:
        HuggingFace Dataset ready for Ragas evaluate().

    Raises:
        ValueError: if lengths don't match.
    """
    if len(query_results) != len(questions):
        raise ValueError(
            f"Length mismatch: {len(query_results)} results vs {len(questions)} questions"
        )

    data_dict = {
        'question': [q.question for q in questions],
        'answer': [r.answer for r in query_results],
        'contexts': [[s.excerpt for s in r.sources] for r in query_results],
        'ground_truth': [q.ground_truth for q in questions],
    }

    return Dataset.from_dict(data_dict)


# ============================================================
# Ragas Metric Calculation
# ============================================================

def calculate_generation_metrics(
    query_results: List[QueryResult],
    questions: List[Question],
    judge_llm: Optional[LangchainLLMWrapper] = None,
    embeddings: Optional[LangchainEmbeddingsWrapper] = None,
) -> GenerationScores:
    """
    Run Ragas evaluation on the dataset and return aggregated generation scores.

    Refusal questions (empty ground_truth_chunk_ids) may produce NaN for
    context_precision and context_recall. These NaN values are filtered out
    when computing aggregate means. Faithfulness, answer_relevancy, and
    answer_correctness work for all questions.

    Args:
        query_results: API responses for each question.
        questions: Golden dataset entries.
        judge_llm: Optional pre-configured judge (for testing). Defaults to Gemini.
        embeddings: Optional pre-configured embeddings (for testing).

    Returns:
        GenerationScores with aggregate means. Metric may be None if all
        values were NaN.
    """
    if judge_llm is None:
        judge_llm = create_gemini_judge()
    if embeddings is None:
        embeddings = create_gemini_embeddings()

    dataset = build_ragas_dataset(query_results, questions)

    result = evaluate(
        dataset,
        metrics=[
            faithfulness,
            answer_relevancy,
            context_precision,
            context_recall,
            answer_correctness,
        ],
        llm=judge_llm,
        embeddings=embeddings,
    )

    # Ragas returns a result object whose .to_pandas() yields per-row scores.
    # Aggregate via NaN-aware mean.
    result_dict = result.to_pandas().to_dict(orient='list')

    return GenerationScores(
        faithfulness=_safe_mean(result_dict.get('faithfulness', [])),
        answer_relevancy=_safe_mean(result_dict.get('answer_relevancy', [])),
        context_precision=_safe_mean(result_dict.get('context_precision', [])),
        context_recall=_safe_mean(result_dict.get('context_recall', [])),
        answer_correctness=_safe_mean(result_dict.get('answer_correctness', [])),
        questions_total=len(questions),
        questions_evaluated_for_context=_count_valid(result_dict.get('context_recall', [])),
        questions_evaluated_for_faithfulness=_count_valid(result_dict.get('faithfulness', [])),
    )


def get_per_question_scores(
    query_results: List[QueryResult],
    questions: List[Question],
    judge_llm: Optional[LangchainLLMWrapper] = None,
    embeddings: Optional[LangchainEmbeddingsWrapper] = None,
) -> List[PerQuestionGenerationScore]:
    """
    Run Ragas and return per-question scores for detailed reporting.

    Useful in the orchestrator's failure analysis to show which questions
    had low faithfulness, off-topic answers, etc.
    """
    if judge_llm is None:
        judge_llm = create_gemini_judge()
    if embeddings is None:
        embeddings = create_gemini_embeddings()

    dataset = build_ragas_dataset(query_results, questions)
    result = evaluate(
        dataset,
        metrics=[
            faithfulness,
            answer_relevancy,
            context_precision,
            context_recall,
            answer_correctness,
        ],
        llm=judge_llm,
        embeddings=embeddings,
    )

    df = result.to_pandas()
    per_question = []
    for idx, question in enumerate(questions):
        per_question.append(PerQuestionGenerationScore(
            question_id=question.id,
            faithfulness=_get_score(df, idx, 'faithfulness'),
            answer_relevancy=_get_score(df, idx, 'answer_relevancy'),
            context_precision=_get_score(df, idx, 'context_precision'),
            context_recall=_get_score(df, idx, 'context_recall'),
            answer_correctness=_get_score(df, idx, 'answer_correctness'),
        ))

    return per_question


# ============================================================
# Helpers
# ============================================================

def _safe_mean(values: List[Any]) -> Optional[float]:
    """
    Compute the mean of a list, skipping NaN values.

    Returns None if all values are NaN or list is empty.
    """
    valid = [v for v in values if v is not None and not _is_nan(v)]
    if not valid:
        return None
    return sum(valid) / len(valid)


def _count_valid(values: List[Any]) -> int:
    """Count non-NaN values in a list."""
    return sum(1 for v in values if v is not None and not _is_nan(v))


def _is_nan(value: Any) -> bool:
    """Check if a value is NaN, handling floats and other types."""
    try:
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return False


def _get_score(df: Any, idx: int, column: str) -> Optional[float]:
    """Safely extract a score from a Ragas pandas DataFrame, returning None for NaN."""
    if column not in df.columns:
        return None
    value = df.iloc[idx][column]
    if value is None or _is_nan(value):
        return None
    return float(value)
