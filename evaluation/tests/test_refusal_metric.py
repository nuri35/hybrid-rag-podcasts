import pytest

from evaluation.modules.refusal_metric import (
    is_refusal_response,
    check_refusal_compliance,
    get_detailed_checks,
)
from evaluation.modules.dataset import Question
from evaluation.modules.api_client import QueryResult, Source


# ============================================================
# is_refusal_response — pattern detection
# ============================================================

def test_direct_refusal_detected():
    assert is_refusal_response("I cannot answer this question.") is True


def test_cant_contraction_detected():
    assert is_refusal_response("I can't answer your question right now.") is True


def test_unable_phrase_detected():
    assert is_refusal_response("I am unable to answer that.") is True


def test_sources_do_not_contain():
    assert is_refusal_response("The sources do not contain information about that.") is True


def test_not_mentioned_in_sources():
    assert is_refusal_response("This topic is not mentioned in the provided sources.") is True


def test_insufficient_information():
    assert is_refusal_response("There is insufficient information to answer.") is True


def test_outside_scope():
    assert is_refusal_response("That question is outside the scope of this discussion.") is True


def test_normal_answer_not_refusal():
    assert is_refusal_response("The capital of France is Paris.") is False


def test_factual_answer_not_refusal():
    assert is_refusal_response(
        "Christof Koch is a neuroscientist who studies consciousness."
    ) is False


def test_empty_string_not_refusal():
    assert is_refusal_response("") is False


def test_whitespace_only_not_refusal():
    assert is_refusal_response("   \n  \t  ") is False


def test_case_insensitive_match():
    assert is_refusal_response("I CANNOT ANSWER THIS QUESTION") is True
    assert is_refusal_response("the Sources Do Not Contain Information") is True


def test_refusal_with_extra_context():
    """Refusal pattern + apologetic preamble still counts."""
    answer = "I apologize, but I cannot answer this question from the given sources."
    assert is_refusal_response(answer) is True


def test_partial_match_not_counted():
    """'I cannot' alone is not enough — needs to follow refusal grammar."""
    assert is_refusal_response("I cannot wait to tell you about this!") is False


def test_long_answer_with_refusal_phrase():
    """Even in a longer answer, a refusal phrase triggers detection."""
    answer = (
        "Let me look at the sources carefully. The sources do not contain "
        "specific information about programming languages."
    )
    assert is_refusal_response(answer) is True


# ============================================================
# check_refusal_compliance — aggregation
# ============================================================

def _make_question(qid: str, is_refusal: bool) -> Question:
    return Question(
        id=qid,
        question=f"Question {qid}",
        ground_truth="Ground truth",
        ground_truth_chunk_ids=[] if is_refusal else ["chunk_1"],
        difficulty="edge" if is_refusal else "easy",
        category="edge_case" if is_refusal else "factual_lookup",
        notes="test",
    )


def _make_result(answer: str) -> QueryResult:
    return QueryResult(
        question="placeholder",
        answer=answer,
        sources=[Source(chunk_id="c1", score=0.8, excerpt="x", metadata={})],
    )


def test_perfect_refusal_compliance():
    """All refusal questions correctly refused."""
    questions = [
        _make_question("q001", is_refusal=True),
        _make_question("q002", is_refusal=True),
        _make_question("q003", is_refusal=False),
    ]
    results = [
        _make_result("I cannot answer this question from the sources."),
        _make_result("The sources do not contain that information."),
        _make_result("The answer is XYZ."),
    ]

    score = check_refusal_compliance(questions, results)

    assert score.refusal_compliance == 1.0
    assert score.total_refusal_questions == 2
    assert score.correctly_refused == 2
    assert score.incorrectly_answered == []


def test_partial_refusal_compliance():
    """Some refusal questions hallucinated instead of refusing."""
    questions = [
        _make_question("q001", is_refusal=True),
        _make_question("q002", is_refusal=True),
        _make_question("q003", is_refusal=True),
        _make_question("q004", is_refusal=True),
    ]
    results = [
        _make_result("I cannot answer this question."),
        _make_result("The sources do not contain that information."),
        _make_result("The answer is fabricated content."),  # hallucination
        _make_result("That topic is outside the scope of these sources."),
    ]

    score = check_refusal_compliance(questions, results)

    assert score.refusal_compliance == 0.75
    assert score.total_refusal_questions == 4
    assert score.correctly_refused == 3
    assert score.incorrectly_answered == ["q003"]


def test_zero_refusal_compliance():
    """LLM hallucinated on every refusal question."""
    questions = [_make_question(f"q00{i}", is_refusal=True) for i in range(1, 4)]
    results = [_make_result("Fabricated answer here.") for _ in range(3)]

    score = check_refusal_compliance(questions, results)

    assert score.refusal_compliance == 0.0
    assert score.correctly_refused == 0
    assert len(score.incorrectly_answered) == 3


def test_length_mismatch_raises():
    """Mismatched questions/results lengths raise."""
    questions = [_make_question("q001", is_refusal=True)]
    results = []

    with pytest.raises(ValueError, match="Length mismatch"):
        check_refusal_compliance(questions, results)


def test_no_refusal_questions_raises():
    """Dataset without any refusal questions raises (caller should know)."""
    questions = [
        _make_question("q001", is_refusal=False),
        _make_question("q002", is_refusal=False),
    ]
    results = [_make_result("Answer 1"), _make_result("Answer 2")]

    with pytest.raises(ValueError, match="No refusal-type questions"):
        check_refusal_compliance(questions, results)


def test_non_refusal_questions_ignored():
    """Non-refusal questions don't count even if they coincidentally refused."""
    questions = [
        _make_question("q001", is_refusal=True),
        _make_question("q002", is_refusal=False),  # not refusal-expected
    ]
    results = [
        _make_result("I cannot answer this."),  # correctly refused
        _make_result("The sources do not contain..."),  # refused but wasn't supposed to
    ]

    score = check_refusal_compliance(questions, results)

    # Only q001 counts for refusal compliance — q002 ignored regardless
    assert score.refusal_compliance == 1.0
    assert score.total_refusal_questions == 1


# ============================================================
# get_detailed_checks — per-question breakdown
# ============================================================

def test_detailed_checks_include_all_questions():
    """All questions returned (not just refusal-expected ones)."""
    questions = [
        _make_question("q001", is_refusal=True),
        _make_question("q002", is_refusal=False),
        _make_question("q003", is_refusal=True),
    ]
    results = [
        _make_result("I cannot answer."),
        _make_result("Normal answer."),
        _make_result("Wrong, fabricated answer."),
    ]

    checks = get_detailed_checks(questions, results)

    assert len(checks) == 3
    assert checks[0].is_compliant is True
    assert checks[1].is_compliant is True  # non-refusal correctly answered
    assert checks[2].is_compliant is False  # refusal expected but didn't refuse


def test_detailed_check_includes_answer_excerpt():
    """Answer excerpt limited to 200 chars."""
    questions = [_make_question("q001", is_refusal=True)]
    long_answer = "X" * 500
    results = [_make_result(long_answer)]

    checks = get_detailed_checks(questions, results)

    assert len(checks[0].answer_excerpt) == 200
