import json
import pytest
from pathlib import Path

from evaluation.modules.report import write_markdown_report, write_json_report
from evaluation.modules.dataset import Question
from evaluation.modules.api_client import QueryResult, Source
from evaluation.modules.retrieval_metrics import AggregateRetrievalScores, RetrievalScores
from evaluation.modules.generation_metrics import GenerationScores, PerQuestionGenerationScore
from evaluation.modules.refusal_metric import RefusalComplianceScore, RefusalCheck
from evaluation.modules.diagnosis import DiagnosticReport, DiagnosticFinding, Severity, Layer


def _sample_question(qid="q001", is_refusal=False):
    return Question(
        id=qid, question=f"Q {qid}?", ground_truth="GT",
        ground_truth_chunk_ids=[] if is_refusal else ["c1"],
        difficulty="edge" if is_refusal else "easy",
        category="edge_case" if is_refusal else "factual_lookup",
        notes="x",
    )


def _sample_query_result(qid="q001"):
    return QueryResult(
        question=f"Q {qid}?", answer=f"Answer for {qid}",
        sources=[Source(chunk_id="c1", score=0.9, excerpt="e", metadata={})],
    )


def _sample_aggregate_retrieval():
    return AggregateRetrievalScores(
        mrr=0.78, hit_at_k=0.91, precision_at_k=0.65, recall_at_k=0.68,
        k=5, questions_evaluated=20, questions_skipped=5,
    )


def _sample_generation():
    return GenerationScores(
        faithfulness=0.84, answer_relevancy=0.91, context_recall=0.82,
        questions_total=25, questions_evaluated_for_context=21,
        questions_evaluated_for_faithfulness=25,
    )


def _sample_refusal():
    return RefusalComplianceScore(
        refusal_compliance=0.75, total_refusal_questions=4,
        correctly_refused=3, incorrectly_answered=["q005"],
    )


def _sample_diagnostic():
    return DiagnosticReport(
        findings=[
            DiagnosticFinding(
                severity=Severity.HEALTHY, layer=Layer.SYSTEM,
                title="System healthy", detail="All metrics OK",
                suggested_actions=[],
            ),
        ],
        overall_health=Severity.HEALTHY,
    )


def test_markdown_report_writes_file(tmp_path):
    path = tmp_path / "report.md"

    write_markdown_report(
        output_path=path,
        run_date="2026-06-05", dataset_version="1.0",
        retrieval=_sample_aggregate_retrieval(),
        generation=_sample_generation(),
        refusal=_sample_refusal(),
        diagnostic=_sample_diagnostic(),
        questions=[_sample_question()],
        query_results=[_sample_query_result()],
        per_question_retrieval=[RetrievalScores(mrr=0.5, hit_at_k=1.0, precision_at_k=0.2, recall_at_k=1.0, k=5)],
        per_question_generation=[PerQuestionGenerationScore(
            question_id="q001", faithfulness=0.85, answer_relevancy=0.9,
            context_recall=0.85,
        )],
        per_question_refusal=[RefusalCheck(
            question_id="q001", expected_refusal=False, actually_refused=False,
            answer_excerpt="Answer for q001",
        )],
    )

    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "RAG Evaluation Report" in content
    assert "Faithfulness" in content
    assert "0.840" in content  # generation faithfulness
    assert "## Per-Question Breakdown" in content

    # Retained 3 metrics present
    assert "| Faithfulness |" in content
    assert "| Answer Relevancy |" in content
    assert "| Context Recall |" in content
    # Regression guard: trimmed metrics must NOT appear (5→3 trim)
    assert "Context Precision" not in content
    assert "Answer Correctness" not in content


def test_markdown_report_handles_none_metrics(tmp_path):
    """Metrics with None values render as 'N/A' instead of crashing."""
    path = tmp_path / "report.md"
    gen_with_nones = GenerationScores(
        faithfulness=None, answer_relevancy=0.85, context_recall=None,
        questions_total=25, questions_evaluated_for_context=0,
        questions_evaluated_for_faithfulness=0,
    )

    write_markdown_report(
        output_path=path,
        run_date="2026-06-05", dataset_version="1.0",
        retrieval=_sample_aggregate_retrieval(),
        generation=gen_with_nones,
        refusal=None,
        diagnostic=_sample_diagnostic(),
        questions=[_sample_question()],
        query_results=[_sample_query_result()],
        per_question_retrieval=[RetrievalScores(mrr=None, hit_at_k=None, precision_at_k=None, recall_at_k=None, k=5)],
        per_question_generation=[],
        per_question_refusal=[],
    )

    content = path.read_text(encoding="utf-8")
    assert "N/A" in content


def test_json_report_writes_valid_json(tmp_path):
    path = tmp_path / "report.json"

    write_json_report(
        output_path=path,
        run_date="2026-06-05", dataset_version="1.0",
        retrieval=_sample_aggregate_retrieval(),
        generation=_sample_generation(),
        refusal=_sample_refusal(),
        diagnostic=_sample_diagnostic(),
        questions=[_sample_question("q001"), _sample_question("q005", is_refusal=True)],
        query_results=[_sample_query_result("q001"), _sample_query_result("q005")],
        per_question_retrieval=[
            RetrievalScores(mrr=0.5, hit_at_k=1.0, precision_at_k=0.2, recall_at_k=1.0, k=5),
            RetrievalScores(mrr=None, hit_at_k=None, precision_at_k=None, recall_at_k=None, k=5),
        ],
        per_question_generation=[
            PerQuestionGenerationScore(question_id="q001", faithfulness=0.85, answer_relevancy=0.9,
                context_recall=0.85),
            PerQuestionGenerationScore(question_id="q005", faithfulness=0.7, answer_relevancy=0.8,
                context_recall=None),
        ],
        per_question_refusal=[
            RefusalCheck(question_id="q001", expected_refusal=False, actually_refused=False, answer_excerpt="x"),
            RefusalCheck(question_id="q005", expected_refusal=True, actually_refused=True, answer_excerpt="cannot answer"),
        ],
    )

    assert path.exists()
    data = json.loads(path.read_text())
    assert data["run_date"] == "2026-06-05"
    assert data["total_questions"] == 2
    assert data["aggregate"]["retrieval"]["mrr"] == 0.78
    assert len(data["per_question"]) == 2
    assert data["per_question"][1]["is_refusal_expected"] is True


def test_json_report_serializes_severity_as_string(tmp_path):
    """Diagnostic severity enums must serialize as strings, not raw enum values."""
    path = tmp_path / "report.json"

    write_json_report(
        output_path=path,
        run_date="2026-06-05", dataset_version="1.0",
        retrieval=_sample_aggregate_retrieval(),
        generation=_sample_generation(),
        refusal=None,
        diagnostic=DiagnosticReport(
            findings=[DiagnosticFinding(
                severity=Severity.WARNING, layer=Layer.RETRIEVAL,
                title="t", detail="d", suggested_actions=["a1"],
            )],
            overall_health=Severity.WARNING,
        ),
        questions=[], query_results=[], per_question_retrieval=[],
        per_question_generation=[], per_question_refusal=[],
    )

    data = json.loads(path.read_text())
    assert data["diagnostic"]["overall_health"] == "WARNING"
    assert data["diagnostic"]["findings"][0]["severity"] == "WARNING"
    assert data["diagnostic"]["findings"][0]["layer"] == "RETRIEVAL"
