import pytest
from evaluation.modules.diagnosis import (
    diagnose,
    Severity,
    Layer,
    DiagnosticFinding,
    DiagnosticReport,
    FAITHFULNESS_PROBLEMATIC,
    FAITHFULNESS_CRITICAL,
    CONTEXT_RECALL_PROBLEMATIC,
)
from evaluation.modules.retrieval_metrics import AggregateRetrievalScores
from evaluation.modules.generation_metrics import GenerationScores
from evaluation.modules.refusal_metric import RefusalComplianceScore


def _healthy_retrieval():
    return AggregateRetrievalScores(
        mrr=0.85, hit_at_k=0.95, precision_at_k=0.75, recall_at_k=0.85,
        k=5, questions_evaluated=20, questions_skipped=5,
    )


def _healthy_generation():
    return GenerationScores(
        faithfulness=0.88, answer_relevancy=0.91, context_precision=0.85,
        context_recall=0.87, answer_correctness=0.83,
        questions_total=25, questions_evaluated_for_context=21,
        questions_evaluated_for_faithfulness=25,
    )


def _healthy_refusal():
    return RefusalComplianceScore(
        refusal_compliance=1.0, total_refusal_questions=4,
        correctly_refused=4, incorrectly_answered=[],
    )


# ============================================================
# Healthy baseline
# ============================================================

def test_diagnose_healthy_system_returns_healthy():
    report = diagnose(_healthy_retrieval(), _healthy_generation(), _healthy_refusal())
    assert report.is_healthy
    assert report.overall_health == Severity.HEALTHY


# ============================================================
# Layer-level diagnosis
# ============================================================

def test_diagnose_both_layers_low_critical():
    """Faithfulness low + Context Recall low → CRITICAL, BOTH layer."""
    gen = GenerationScores(
        faithfulness=0.5, answer_relevancy=0.85, context_precision=0.6,
        context_recall=0.5, answer_correctness=0.6,
        questions_total=25, questions_evaluated_for_context=21,
        questions_evaluated_for_faithfulness=25,
    )
    report = diagnose(_healthy_retrieval(), gen, _healthy_refusal())

    critical = report.critical_findings()
    assert any(f.layer == Layer.BOTH for f in critical)
    assert report.overall_health == Severity.CRITICAL


def test_diagnose_retrieval_only_low():
    """Context Recall low, Faithfulness healthy → RETRIEVAL warning."""
    gen = GenerationScores(
        faithfulness=0.88, answer_relevancy=0.85, context_precision=0.6,
        context_recall=0.5, answer_correctness=0.7,
        questions_total=25, questions_evaluated_for_context=21,
        questions_evaluated_for_faithfulness=25,
    )
    report = diagnose(_healthy_retrieval(), gen, _healthy_refusal())

    retrieval_findings = [f for f in report.findings if f.layer == Layer.RETRIEVAL]
    assert any(f.severity == Severity.WARNING for f in retrieval_findings)


def test_diagnose_generation_critical_when_faithfulness_very_low():
    """Faithfulness < CRITICAL threshold → CRITICAL severity."""
    gen = GenerationScores(
        faithfulness=0.4, answer_relevancy=0.85, context_precision=0.85,
        context_recall=0.85, answer_correctness=0.6,
        questions_total=25, questions_evaluated_for_context=21,
        questions_evaluated_for_faithfulness=25,
    )
    report = diagnose(_healthy_retrieval(), gen, _healthy_refusal())

    gen_findings = [f for f in report.findings if f.layer == Layer.GENERATION]
    assert any(f.severity == Severity.CRITICAL for f in gen_findings)


def test_diagnose_handles_none_faithfulness():
    """If faithfulness is None (Ragas failed), should emit a warning, not crash."""
    gen = GenerationScores(
        faithfulness=None, answer_relevancy=0.85, context_precision=None,
        context_recall=None, answer_correctness=0.7,
        questions_total=25, questions_evaluated_for_context=0,
        questions_evaluated_for_faithfulness=0,
    )
    report = diagnose(_healthy_retrieval(), gen, _healthy_refusal())

    system_warnings = [f for f in report.findings if f.layer == Layer.SYSTEM and f.severity == Severity.WARNING]
    assert len(system_warnings) >= 1


# ============================================================
# Retrieval drill-down
# ============================================================

def test_diagnose_low_hit_at_k_flagged():
    """Hit@K below threshold → coverage warning."""
    ret = AggregateRetrievalScores(
        mrr=0.7, hit_at_k=0.5, precision_at_k=0.7, recall_at_k=0.7,
        k=5, questions_evaluated=20, questions_skipped=5,
    )
    report = diagnose(ret, _healthy_generation(), _healthy_refusal())

    titles = [f.title for f in report.findings]
    assert any("Hit@" in t for t in titles)


def test_diagnose_low_mrr_only_flagged():
    """Healthy Hit@K but low MRR → ranking warning, not coverage."""
    ret = AggregateRetrievalScores(
        mrr=0.3, hit_at_k=0.9, precision_at_k=0.7, recall_at_k=0.7,
        k=5, questions_evaluated=20, questions_skipped=5,
    )
    report = diagnose(ret, _healthy_generation(), _healthy_refusal())

    titles = [f.title for f in report.findings]
    assert any("MRR" in t for t in titles)


def test_diagnose_low_precision_noise_warning():
    ret = AggregateRetrievalScores(
        mrr=0.8, hit_at_k=0.9, precision_at_k=0.2, recall_at_k=0.7,
        k=5, questions_evaluated=20, questions_skipped=5,
    )
    report = diagnose(ret, _healthy_generation(), _healthy_refusal())

    titles = [f.title for f in report.findings]
    assert any("noise" in t.lower() or "Precision@" in t for t in titles)


# ============================================================
# Refusal compliance
# ============================================================

def test_diagnose_low_refusal_critical():
    refusal = RefusalComplianceScore(
        refusal_compliance=0.25, total_refusal_questions=4,
        correctly_refused=1, incorrectly_answered=["q005", "q010", "q020"],
    )
    report = diagnose(_healthy_retrieval(), _healthy_generation(), refusal)

    refusal_findings = [f for f in report.findings if f.layer == Layer.REFUSAL]
    assert any(f.severity == Severity.CRITICAL for f in refusal_findings)


def test_diagnose_perfect_refusal_healthy():
    report = diagnose(_healthy_retrieval(), _healthy_generation(), _healthy_refusal())
    refusal_findings = [f for f in report.findings if f.layer == Layer.REFUSAL]
    assert all(f.severity == Severity.HEALTHY for f in refusal_findings)


def test_diagnose_none_refusal_ok():
    """If no refusal questions exist in dataset, refusal param is None."""
    report = diagnose(_healthy_retrieval(), _healthy_generation(), None)
    refusal_findings = [f for f in report.findings if f.layer == Layer.REFUSAL]
    assert len(refusal_findings) == 0


# ============================================================
# Overall health aggregation
# ============================================================

def test_overall_health_takes_most_severe():
    """If any finding is CRITICAL, overall is CRITICAL."""
    refusal = RefusalComplianceScore(
        refusal_compliance=0.0, total_refusal_questions=4,
        correctly_refused=0, incorrectly_answered=["q005", "q010", "q020", "q025"],
    )
    report = diagnose(_healthy_retrieval(), _healthy_generation(), refusal)
    assert report.overall_health == Severity.CRITICAL
