"""
Diagnostic engine for RAG evaluation results.

Pure logic — no LLM calls, no calculations. Takes pre-computed scores
from retrieval, generation, and refusal metrics, applies the diagnostic
map from the planning discussion, and produces actionable findings.

The diagnostic map mirrors what was discussed during sprint planning:
- Context Recall + Faithfulness together identify which LAYER failed
- Then per-layer metrics identify which TYPE of issue
- Each finding includes suggested next actions
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional

from evaluation.modules.retrieval_metrics import AggregateRetrievalScores
from evaluation.modules.generation_metrics import GenerationScores
from evaluation.modules.refusal_metric import RefusalComplianceScore


# ============================================================
# Thresholds — single source of truth
# ============================================================

# Generation health thresholds
FAITHFULNESS_HEALTHY = 0.8
FAITHFULNESS_PROBLEMATIC = 0.7
FAITHFULNESS_CRITICAL = 0.5

CONTEXT_RECALL_HEALTHY = 0.8
CONTEXT_RECALL_PROBLEMATIC = 0.7

ANSWER_RELEVANCY_HEALTHY = 0.8
ANSWER_RELEVANCY_PROBLEMATIC = 0.7

# Retrieval health thresholds
MRR_HEALTHY = 0.7
MRR_PROBLEMATIC = 0.5

HIT_AT_K_HEALTHY = 0.85
HIT_AT_K_PROBLEMATIC = 0.7

PRECISION_AT_K_PROBLEMATIC = 0.4
RECALL_AT_K_PROBLEMATIC = 0.6

# Refusal compliance threshold
REFUSAL_COMPLIANCE_HEALTHY = 0.8
REFUSAL_COMPLIANCE_PROBLEMATIC = 0.5


# ============================================================
# Types
# ============================================================

class Severity(str, Enum):
    HEALTHY = "HEALTHY"
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class Layer(str, Enum):
    RETRIEVAL = "RETRIEVAL"
    GENERATION = "GENERATION"
    BOTH = "BOTH"
    REFUSAL = "REFUSAL"
    SYSTEM = "SYSTEM"  # general health note


@dataclass(frozen=True)
class DiagnosticFinding:
    """A single diagnostic observation with suggested actions."""
    severity: Severity
    layer: Layer
    title: str  # short headline
    detail: str  # explanation of what was observed
    suggested_actions: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class DiagnosticReport:
    """Complete diagnostic report — collection of findings + overall verdict."""
    findings: List[DiagnosticFinding]
    overall_health: Severity  # most severe finding's severity, or HEALTHY

    @property
    def is_healthy(self) -> bool:
        return self.overall_health == Severity.HEALTHY

    def critical_findings(self) -> List[DiagnosticFinding]:
        return [f for f in self.findings if f.severity == Severity.CRITICAL]

    def warnings(self) -> List[DiagnosticFinding]:
        return [f for f in self.findings if f.severity == Severity.WARNING]


# ============================================================
# Diagnostic Logic
# ============================================================

def diagnose(
    retrieval: AggregateRetrievalScores,
    generation: GenerationScores,
    refusal: Optional[RefusalComplianceScore],
) -> DiagnosticReport:
    """
    Apply the diagnostic map to produce structured findings.

    Order of analysis (per planning discussion):
    1. First check which LAYER has issues (Context Recall vs Faithfulness)
    2. Then drill into the failing layer's metrics
    3. Check Answer Relevancy as a secondary signal
    4. Check refusal compliance separately
    5. Compute overall health from worst finding

    Args:
        retrieval: aggregate retrieval scores (custom metrics)
        generation: aggregate generation scores (Ragas)
        refusal: refusal compliance results (None if dataset has no refusal questions)

    Returns:
        DiagnosticReport with findings and overall verdict.
    """
    findings: List[DiagnosticFinding] = []

    # ============================================================
    # Layer-level diagnosis (Context Recall + Faithfulness)
    # ============================================================

    faithfulness = generation.faithfulness
    context_recall = generation.context_recall

    if faithfulness is None or context_recall is None:
        findings.append(DiagnosticFinding(
            severity=Severity.WARNING,
            layer=Layer.SYSTEM,
            title="Layer-level diagnosis incomplete",
            detail=(
                f"Cannot perform full layer diagnosis — "
                f"faithfulness={'N/A' if faithfulness is None else f'{faithfulness:.3f}'}, "
                f"context_recall={'N/A' if context_recall is None else f'{context_recall:.3f}'}. "
                f"This usually means most questions are refusal-type or Ragas returned NaN."
            ),
            suggested_actions=[
                "Ensure dataset has enough non-refusal questions for context metrics",
                "Investigate Ragas output for NaN patterns",
            ],
        ))
    else:
        layer_finding = _diagnose_layer(faithfulness, context_recall)
        if layer_finding:
            findings.append(layer_finding)

    # ============================================================
    # Retrieval drill-down
    # ============================================================

    findings.extend(_diagnose_retrieval(retrieval))

    # ============================================================
    # Generation drill-down (beyond layer-level)
    # ============================================================

    findings.extend(_diagnose_generation(generation))

    # ============================================================
    # Refusal compliance
    # ============================================================

    if refusal is not None:
        refusal_finding = _diagnose_refusal(refusal)
        if refusal_finding:
            findings.append(refusal_finding)

    # ============================================================
    # Overall health = worst severity in findings
    # ============================================================

    overall = _compute_overall_health(findings)

    return DiagnosticReport(findings=findings, overall_health=overall)


def _diagnose_layer(faithfulness: float, context_recall: float) -> Optional[DiagnosticFinding]:
    """Identify which layer (retrieval/generation/both) has issues."""

    faithfulness_low = faithfulness < FAITHFULNESS_PROBLEMATIC
    recall_low = context_recall < CONTEXT_RECALL_PROBLEMATIC

    if faithfulness_low and recall_low:
        return DiagnosticFinding(
            severity=Severity.CRITICAL,
            layer=Layer.BOTH,
            title="Both retrieval and generation are underperforming",
            detail=(
                f"Faithfulness ({faithfulness:.3f}) and Context Recall ({context_recall:.3f}) "
                f"are both below {FAITHFULNESS_PROBLEMATIC}. "
                f"This indicates retrieval is missing key information AND generation is "
                f"hallucinating with what it has."
            ),
            suggested_actions=[
                "Focus on retrieval FIRST — generation cannot improve until context is correct",
                "Increase top-K or add hybrid retrieval (BM25 + vector)",
                "Re-evaluate after retrieval fix, then revisit generation",
            ],
        )

    if recall_low and not faithfulness_low:
        return DiagnosticFinding(
            severity=Severity.WARNING,
            layer=Layer.RETRIEVAL,
            title="Retrieval problem — context is incomplete",
            detail=(
                f"Context Recall ({context_recall:.3f}) is low while Faithfulness "
                f"({faithfulness:.3f}) is healthy. Generation is honest with what it gets, "
                f"but it's not getting enough."
            ),
            suggested_actions=[
                "Increase top-K (currently 5 → try 10)",
                "Add hybrid retrieval (BM25 + vector)",
                "Try multi-query retrieval (rephrase the question multiple ways)",
                "Inspect chunking strategy — may be splitting context too aggressively",
            ],
        )

    if faithfulness_low and not recall_low:
        severity = Severity.CRITICAL if faithfulness < FAITHFULNESS_CRITICAL else Severity.WARNING
        return DiagnosticFinding(
            severity=severity,
            layer=Layer.GENERATION,
            title="Generation problem — LLM is hallucinating",
            detail=(
                f"Faithfulness ({faithfulness:.3f}) is low while Context Recall "
                f"({context_recall:.3f}) is healthy. The information is there, but the "
                f"LLM isn't using it faithfully."
            ),
            suggested_actions=[
                "Tighten the prompt: 'ONLY use information from sources'",
                "Enforce citation: every claim MUST have [Source N] marker",
                "Add output validation layer (reject answers without citations)",
                "Lower maxOutputTokens — longer answers correlate with more hallucination",
                "Consider switching to a model that is better at instruction-following",
            ],
        )

    # Both healthy
    return DiagnosticFinding(
        severity=Severity.HEALTHY,
        layer=Layer.SYSTEM,
        title="System is healthy at the layer level",
        detail=(
            f"Faithfulness ({faithfulness:.3f}) and Context Recall ({context_recall:.3f}) "
            f"are both above thresholds. Both retrieval and generation layers are functioning well."
        ),
        suggested_actions=[],
    )


def _diagnose_retrieval(retrieval: AggregateRetrievalScores) -> List[DiagnosticFinding]:
    """Drill into retrieval metrics to identify specific issue type."""
    findings = []

    if retrieval.hit_at_k < HIT_AT_K_PROBLEMATIC:
        findings.append(DiagnosticFinding(
            severity=Severity.WARNING,
            layer=Layer.RETRIEVAL,
            title=f"Hit@{retrieval.k} is low — coverage problem",
            detail=(
                f"Hit@{retrieval.k} = {retrieval.hit_at_k:.3f}. The retrieval often fails to "
                f"return any relevant chunk in top-{retrieval.k}."
            ),
            suggested_actions=[
                f"Increase top-K (try {retrieval.k * 2})",
                "Switch to a stronger embedding model",
                "Add hybrid retrieval (BM25 alongside vector)",
                "Review chunking strategy",
            ],
        ))
    elif retrieval.mrr < MRR_PROBLEMATIC:
        findings.append(DiagnosticFinding(
            severity=Severity.WARNING,
            layer=Layer.RETRIEVAL,
            title="MRR is low — ranking problem",
            detail=(
                f"MRR = {retrieval.mrr:.3f}. Relevant chunks are being retrieved but "
                f"not ranked at the top, so the LLM sees the important context too late."
            ),
            suggested_actions=[
                "Add a cross-encoder re-ranker on top-K results",
                "Tune similarity threshold",
            ],
        ))

    if retrieval.precision_at_k < PRECISION_AT_K_PROBLEMATIC:
        findings.append(DiagnosticFinding(
            severity=Severity.INFO,
            layer=Layer.RETRIEVAL,
            title=f"Precision@{retrieval.k} is low — noise problem",
            detail=(
                f"Precision@{retrieval.k} = {retrieval.precision_at_k:.3f}. Too many "
                f"irrelevant chunks are in top-{retrieval.k}, which can confuse the LLM."
            ),
            suggested_actions=[
                "Add a re-ranker to push noise down",
                "Raise similarity threshold (filter out low-score chunks)",
                f"Reduce top-K to {max(3, retrieval.k - 2)}",
            ],
        ))

    if retrieval.recall_at_k < RECALL_AT_K_PROBLEMATIC:
        findings.append(DiagnosticFinding(
            severity=Severity.INFO,
            layer=Layer.RETRIEVAL,
            title=f"Recall@{retrieval.k} is low — completeness problem",
            detail=(
                f"Recall@{retrieval.k} = {retrieval.recall_at_k:.3f}. Some relevant chunks "
                f"exist but aren't being retrieved at all in top-{retrieval.k}."
            ),
            suggested_actions=[
                f"Increase top-K to {retrieval.k * 2}",
                "Try multi-query retrieval",
                "Try query expansion",
            ],
        ))

    return findings


def _diagnose_generation(generation: GenerationScores) -> List[DiagnosticFinding]:
    """Drill into generation metrics beyond the layer-level diagnosis."""
    findings = []

    # Answer Relevancy (off-topic detection)
    if generation.answer_relevancy is not None and generation.answer_relevancy < ANSWER_RELEVANCY_PROBLEMATIC:
        findings.append(DiagnosticFinding(
            severity=Severity.WARNING,
            layer=Layer.GENERATION,
            title="Answer Relevancy is low — answers are off-topic or unfocused",
            detail=(
                f"Answer Relevancy = {generation.answer_relevancy:.3f}. The LLM is producing "
                f"answers that drift from the question or include tangential content."
            ),
            suggested_actions=[
                "Add explicit prompt instruction: 'Answer ONLY the question asked, no tangents'",
                "Lower maxOutputTokens to constrain answer length",
                "Add few-shot examples of focused answers",
            ],
        ))

    return findings


def _diagnose_refusal(refusal: RefusalComplianceScore) -> Optional[DiagnosticFinding]:
    """Diagnose refusal compliance — did the LLM correctly refuse on unanswerable questions?"""

    if refusal.refusal_compliance >= REFUSAL_COMPLIANCE_HEALTHY:
        return DiagnosticFinding(
            severity=Severity.HEALTHY,
            layer=Layer.REFUSAL,
            title="Refusal compliance is healthy",
            detail=(
                f"Refusal compliance = {refusal.refusal_compliance:.3f} "
                f"({refusal.correctly_refused}/{refusal.total_refusal_questions} correctly refused)."
            ),
            suggested_actions=[],
        )

    severity = (
        Severity.CRITICAL if refusal.refusal_compliance < REFUSAL_COMPLIANCE_PROBLEMATIC
        else Severity.WARNING
    )

    return DiagnosticFinding(
        severity=severity,
        layer=Layer.REFUSAL,
        title="Refusal compliance is below threshold — LLM hallucinates on unanswerable questions",
        detail=(
            f"Refusal compliance = {refusal.refusal_compliance:.3f} "
            f"({refusal.correctly_refused}/{refusal.total_refusal_questions} correctly refused). "
            f"Failed questions: {', '.join(refusal.incorrectly_answered)}. "
            f"These are questions where sources don't contain the answer, but the LLM "
            f"fabricated one instead of refusing."
        ),
        suggested_actions=[
            "Strengthen the refusal instruction in the prompt",
            "Add explicit examples of valid refusals (few-shot)",
            "Add output validation: if no citation, treat as refusal candidate",
            "Review the failed questions individually to spot patterns",
        ],
    )


def _compute_overall_health(findings: List[DiagnosticFinding]) -> Severity:
    """Overall = most severe finding among all."""
    if not findings:
        return Severity.HEALTHY

    severity_order = {
        Severity.HEALTHY: 0,
        Severity.INFO: 1,
        Severity.WARNING: 2,
        Severity.CRITICAL: 3,
    }

    max_severity = max(findings, key=lambda f: severity_order[f.severity]).severity
    return max_severity
