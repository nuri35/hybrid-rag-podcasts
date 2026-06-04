"""Deterministic refusal compliance metric (pattern-based, no LLM judge).

On edge-case questions (empty ground_truth_chunk_ids), the system is
expected to refuse rather than fabricate. This module detects
refusal-shaped answers with regex patterns and aggregates the compliance
rate across all refusal-expected questions.

The pattern list is deliberately aligned with Sprint Prompt-Security's
output validation (its valid-refusal regex family), so an answer that
passes output validation as a refusal is also recognized here.
"""

from dataclasses import dataclass
from typing import List
import re

from evaluation.modules.api_client import QueryResult
from evaluation.modules.dataset import Question


# Refusal pattern'ları — LLM'in "cevaplayamıyorum" demesinin bilinen yolları.
# Pattern'lar lowercase'de eşleşiyor, case-insensitive match için.
REFUSAL_PATTERNS = [
    # Direkt reddetme
    r"\bcannot answer (this|your|the) question\b",
    r"\bcan't answer (this|your|the) question\b",
    r"\bunable to answer\b",

    # Source-based reddetme (bizim sistem prompt'umuzun tetiklediği)
    r"\bsources? (do|don't|does|doesn't) (not )?(contain|have|include)\b",
    r"\bnot (mentioned|discussed|covered|addressed) in the (provided |given )?sources?\b",
    r"\bdo(es)? not contain (any |sufficient )?information\b",
    r"\bno (mention|reference|information) (of|about|regarding)\b",

    # Insufficient bilgi
    r"\binsufficient (information|context|details|sources?)\b",
    r"\bnot enough (information|context|details)\b",

    # Out-of-scope
    r"\boutside the scope\b",
    r"\bbeyond (the |my )?(scope|capabilities)\b",
    r"\bnot (related to|relevant to) the (provided |given )?(sources?|context|podcast)\b",

    # "I cannot" + reasoning
    r"\bi (cannot|can't|am unable to) (answer|respond|address|help with)\b",
]


@dataclass(frozen=True)
class RefusalCheck:
    """Per-question refusal compliance result."""
    question_id: str
    expected_refusal: bool   # Was this an edge/refusal question?
    actually_refused: bool   # Did the LLM produce a refusal-shaped answer?
    answer_excerpt: str      # First 200 chars of answer for debugging

    @property
    def is_compliant(self) -> bool:
        """True when expected and actual match."""
        return self.expected_refusal == self.actually_refused


@dataclass(frozen=True)
class RefusalComplianceScore:
    """Aggregated refusal compliance across all refusal-expected questions."""
    refusal_compliance: float  # Fraction of refusal questions correctly refused
    total_refusal_questions: int
    correctly_refused: int
    incorrectly_answered: List[str]  # Question IDs that should have refused but didn't


def is_refusal_response(answer: str) -> bool:
    """
    Check if an LLM answer matches any known refusal pattern.

    Case-insensitive. Returns True even if the answer also contains
    non-refusal content, as long as a refusal pattern is present.

    Examples:
        >>> is_refusal_response("I cannot answer this question.")
        True
        >>> is_refusal_response("The sources do not contain information about X.")
        True
        >>> is_refusal_response("The answer is 42.")
        False
        >>> is_refusal_response("")
        False
    """
    if not answer or not answer.strip():
        return False

    answer_lower = answer.lower()
    return any(re.search(pattern, answer_lower) for pattern in REFUSAL_PATTERNS)


def check_refusal_compliance(
    questions: List[Question],
    query_results: List[QueryResult],
) -> RefusalComplianceScore:
    """
    Evaluate whether the LLM correctly refused on refusal-expected questions.

    Only counts questions where `is_refusal` is True (empty ground_truth_chunk_ids).
    Non-refusal questions are not penalized for not refusing — they should answer normally.

    Args:
        questions: full dataset (refusal + non-refusal mixed)
        query_results: API responses, must be in the same order as questions

    Returns:
        RefusalComplianceScore with the fraction correctly refused.

    Raises:
        ValueError: if questions and query_results have different lengths.
        ValueError: if no refusal questions exist in the dataset.
    """
    if len(questions) != len(query_results):
        raise ValueError(
            f"Length mismatch: {len(questions)} questions vs {len(query_results)} results"
        )

    refusal_checks = []
    for question, result in zip(questions, query_results):
        actually_refused = is_refusal_response(result.answer)
        refusal_checks.append(RefusalCheck(
            question_id=question.id,
            expected_refusal=question.is_refusal,
            actually_refused=actually_refused,
            answer_excerpt=result.answer[:200],
        ))

    refusal_expected = [c for c in refusal_checks if c.expected_refusal]

    if not refusal_expected:
        raise ValueError("No refusal-type questions found in dataset")

    correctly_refused = sum(1 for c in refusal_expected if c.actually_refused)
    failed_ids = [c.question_id for c in refusal_expected if not c.actually_refused]

    return RefusalComplianceScore(
        refusal_compliance=correctly_refused / len(refusal_expected),
        total_refusal_questions=len(refusal_expected),
        correctly_refused=correctly_refused,
        incorrectly_answered=failed_ids,
    )


def get_detailed_checks(
    questions: List[Question],
    query_results: List[QueryResult],
) -> List[RefusalCheck]:
    """
    Get per-question refusal checks for detailed reporting.

    Useful in the orchestrator to include refusal results in the per-question
    breakdown of the final report.
    """
    if len(questions) != len(query_results):
        raise ValueError(
            f"Length mismatch: {len(questions)} questions vs {len(query_results)} results"
        )

    return [
        RefusalCheck(
            question_id=q.id,
            expected_refusal=q.is_refusal,
            actually_refused=is_refusal_response(r.answer),
            answer_excerpt=r.answer[:200],
        )
        for q, r in zip(questions, query_results)
    ]
