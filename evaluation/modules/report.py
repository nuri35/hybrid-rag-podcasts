"""
Report writer for RAG evaluation runs.

Two outputs:
- Markdown: human-readable, includes diagnostic summary and per-question detail
- JSON: machine-readable, for programmatic comparison across runs

Both written under results/baseline-{date}/ by the orchestrator.
"""

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from evaluation.modules.dataset import Question
from evaluation.modules.api_client import QueryResult
from evaluation.modules.retrieval_metrics import (
    AggregateRetrievalScores,
    RetrievalScores,
)
from evaluation.modules.generation_metrics import (
    GenerationScores,
    PerQuestionGenerationScore,
)
from evaluation.modules.refusal_metric import (
    RefusalComplianceScore,
    RefusalCheck,
)
from evaluation.modules.diagnosis import DiagnosticReport, Severity


# ============================================================
# Markdown Report
# ============================================================

def write_markdown_report(
    output_path: Path,
    run_date: str,
    dataset_version: str,
    retrieval: AggregateRetrievalScores,
    generation: GenerationScores,
    refusal: Optional[RefusalComplianceScore],
    diagnostic: DiagnosticReport,
    questions: List[Question],
    query_results: List[QueryResult],
    per_question_retrieval: List[RetrievalScores],
    per_question_generation: List[PerQuestionGenerationScore],
    per_question_refusal: List[RefusalCheck],
) -> None:
    """
    Write a human-readable markdown report.

    Sections (in order):
    1. Header with metadata
    2. Overall verdict (overall_health emoji + summary)
    3. Aggregate scores tables (retrieval, generation, refusal)
    4. Diagnostic findings (sorted by severity)
    5. Per-question breakdown (table form, all 25)
    6. Failed questions detail (only the ones that underperformed)
    7. Limitations
    """
    lines = []

    # 1. Header
    lines.append(f"# RAG Evaluation Report — {run_date}\n")
    lines.append(f"**Dataset version:** {dataset_version}")
    lines.append(f"**Total questions:** {len(questions)}")
    lines.append(f"**Generated:** {datetime.now().isoformat(timespec='seconds')}\n")

    # 2. Overall verdict
    lines.append("## Overall Verdict\n")
    lines.append(_render_overall_verdict(diagnostic.overall_health))
    lines.append("")

    # 3. Aggregate scores
    lines.append("## Aggregate Scores\n")
    lines.append("### Retrieval Metrics (Custom)\n")
    lines.append("| Metric | Value | k |")
    lines.append("|---|---|---|")
    lines.append(f"| MRR | {retrieval.mrr:.3f} | — |")
    lines.append(f"| Hit@K | {retrieval.hit_at_k:.3f} | {retrieval.k} |")
    lines.append(f"| Precision@K | {retrieval.precision_at_k:.3f} | {retrieval.k} |")
    lines.append(f"| Recall@K | {retrieval.recall_at_k:.3f} | {retrieval.k} |")
    lines.append(f"\n*Evaluated on {retrieval.questions_evaluated} questions ({retrieval.questions_skipped} refusal questions skipped)*\n")

    lines.append("### Generation Metrics (Ragas)\n")
    lines.append("Substantive = non-refusal answers only (Phase 4); refusals are scored "
                 "erratically by Ragas and reported separately under Refusal Compliance.\n")
    lines.append("| Metric | Raw (all) | Substantive (non-refusal) |")
    lines.append("|---|---|---|")
    lines.append(f"| Faithfulness | {_fmt(generation.faithfulness)} | "
                 f"{_fmt(generation.substantive_faithfulness)} |")
    lines.append(f"| Answer Relevancy | {_fmt(generation.answer_relevancy)} | "
                 f"{_fmt(generation.substantive_answer_relevancy)} |")
    lines.append(f"| Context Recall | {_fmt(generation.context_recall)} | — |")
    lines.append("")
    if generation.refusal_count:
        lines.append(f"*Excluded {generation.refusal_count} refusal answer(s) from the "
                     f"substantive aggregate: {', '.join(generation.refusal_question_ids)}.*\n")

    if refusal is not None:
        lines.append("### Refusal Compliance\n")
        lines.append(f"- **Refusal compliance:** {refusal.refusal_compliance:.3f}")
        lines.append(f"- **Correctly refused:** {refusal.correctly_refused} / {refusal.total_refusal_questions}")
        if refusal.incorrectly_answered:
            lines.append(f"- **Failed (hallucinated instead of refusing):** {', '.join(refusal.incorrectly_answered)}")
        lines.append("")

    # 4. Diagnostic findings
    lines.append("## Diagnostic Findings\n")
    if not diagnostic.findings:
        lines.append("_No findings — system is healthy._\n")
    else:
        # Sort: CRITICAL first, then WARNING, then INFO, then HEALTHY
        severity_order = {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.INFO: 2, Severity.HEALTHY: 3}
        sorted_findings = sorted(diagnostic.findings, key=lambda f: severity_order[f.severity])

        for finding in sorted_findings:
            emoji = _severity_emoji(finding.severity)
            lines.append(f"### {emoji} {finding.title}\n")
            lines.append(f"**Severity:** {finding.severity.value}  ")
            lines.append(f"**Layer:** {finding.layer.value}\n")
            lines.append(f"{finding.detail}\n")
            if finding.suggested_actions:
                lines.append("**Suggested actions:**\n")
                for action in finding.suggested_actions:
                    lines.append(f"- {action}")
                lines.append("")

    # 5. Per-question breakdown
    lines.append("## Per-Question Breakdown\n")
    lines.append("| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |")
    lines.append("|---|---|---|---|---|---|---|")
    for i, q in enumerate(questions):
        ret = per_question_retrieval[i]
        gen = per_question_generation[i] if i < len(per_question_generation) else None
        ref = per_question_refusal[i] if i < len(per_question_refusal) else None

        mrr_str = "—" if ret.mrr is None else f"{ret.mrr:.2f}"
        hit_str = "—" if ret.hit_at_k is None else f"{ret.hit_at_k:.0f}"
        faith_str = "—" if gen is None or gen.faithfulness is None else f"{gen.faithfulness:.2f}"
        rel_str = "—" if gen is None or gen.answer_relevancy is None else f"{gen.answer_relevancy:.2f}"
        ref_str = "—"
        if ref is not None and q.is_refusal:
            ref_str = "✓" if ref.actually_refused else "✗"

        lines.append(f"| {q.id} | {q.difficulty} | {mrr_str} | {hit_str} | {faith_str} | {rel_str} | {ref_str} |")
    lines.append("")

    # 6. Failed questions detail
    failed_questions = _identify_failed_questions(
        questions, query_results, per_question_retrieval, per_question_generation, per_question_refusal
    )
    if failed_questions:
        lines.append("## Failed Questions (Detail)\n")
        lines.append("_Questions where one or more metrics fell below thresholds._\n")
        for fq in failed_questions:
            lines.append(f"### {fq['id']} ({fq['difficulty']})\n")
            lines.append(f"**Question:** {fq['question']}\n")
            lines.append(f"**Answer:** {fq['answer_excerpt']}\n")
            lines.append(f"**Issues:** {', '.join(fq['issues'])}\n")

    # 7. Limitations
    lines.append("## Limitations\n")
    lines.append("- Single-instance dataset; no concurrent traffic simulation")
    lines.append("- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production")
    lines.append("  inference, so self-preference bias is possible")
    lines.append("- Context excerpts are 200-char snippets, not full chunks — may affect")
    lines.append("  faithfulness scoring nuance")
    lines.append("- Refusal compliance uses pattern matching, not LLM judgment — may miss")
    lines.append("  paraphrased refusals\n")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")


def _render_overall_verdict(health: Severity) -> str:
    emoji = _severity_emoji(health)
    verdicts = {
        Severity.HEALTHY: f"{emoji} **System is healthy.** All metrics above thresholds.",
        Severity.INFO: f"{emoji} **Functional with minor observations.** No critical issues.",
        Severity.WARNING: f"{emoji} **Issues detected — review diagnostic findings.**",
        Severity.CRITICAL: f"{emoji} **Critical issues — action required before deployment.**",
    }
    return verdicts.get(health, f"**Status:** {health.value}")


def _severity_emoji(severity: Severity) -> str:
    return {
        Severity.HEALTHY: "✅",
        Severity.INFO: "ℹ️",
        Severity.WARNING: "⚠️",
        Severity.CRITICAL: "🔴",
    }.get(severity, "•")


def _fmt(value: Optional[float]) -> str:
    """Format a metric value; show N/A if None."""
    return "N/A" if value is None else f"{value:.3f}"


def _identify_failed_questions(
    questions, query_results, per_q_retrieval, per_q_generation, per_q_refusal
):
    """Find questions that underperformed on any metric. Returns list of dicts."""
    failed = []
    for i, q in enumerate(questions):
        ret = per_q_retrieval[i]
        gen = per_q_generation[i] if i < len(per_q_generation) else None
        ref = per_q_refusal[i] if i < len(per_q_refusal) else None

        issues = []
        if ret.mrr is not None and ret.mrr < 0.5:
            issues.append(f"low MRR ({ret.mrr:.2f})")
        if ret.hit_at_k is not None and ret.hit_at_k < 1.0:
            issues.append(f"missed hit@{ret.k}")
        if gen is not None and gen.faithfulness is not None and gen.faithfulness < 0.7:
            issues.append(f"low faithfulness ({gen.faithfulness:.2f})")
        if gen is not None and gen.answer_relevancy is not None and gen.answer_relevancy < 0.7:
            issues.append(f"low relevancy ({gen.answer_relevancy:.2f})")
        if ref is not None and q.is_refusal and not ref.actually_refused:
            issues.append("hallucinated instead of refusing")

        if issues:
            answer = query_results[i].answer if i < len(query_results) else ""
            failed.append({
                "id": q.id,
                "difficulty": q.difficulty,
                "question": q.question,
                "answer_excerpt": (answer[:200] + "...") if len(answer) > 200 else answer,
                "issues": issues,
            })
    return failed


# ============================================================
# JSON Report
# ============================================================

def write_json_report(
    output_path: Path,
    run_date: str,
    dataset_version: str,
    retrieval: AggregateRetrievalScores,
    generation: GenerationScores,
    refusal: Optional[RefusalComplianceScore],
    diagnostic: DiagnosticReport,
    questions: List[Question],
    query_results: List[QueryResult],
    per_question_retrieval: List[RetrievalScores],
    per_question_generation: List[PerQuestionGenerationScore],
    per_question_refusal: List[RefusalCheck],
) -> None:
    """
    Write a machine-readable JSON report.

    Structured for programmatic comparison: future runs can be diffed against
    a previous baseline.json to see "Faithfulness went up by 0.05" etc.
    """

    per_question = []
    for i, q in enumerate(questions):
        per_question.append({
            "id": q.id,
            "question": q.question,
            "difficulty": q.difficulty,
            "category": q.category,
            "is_refusal_expected": q.is_refusal,
            "retrieval": asdict(per_question_retrieval[i]),
            "generation": asdict(per_question_generation[i]) if i < len(per_question_generation) else None,
            "refusal": asdict(per_question_refusal[i]) if i < len(per_question_refusal) else None,
            "retrieved_chunk_ids": query_results[i].retrieved_chunk_ids if i < len(query_results) else [],
            # Phase 4: the pre-expansion fused top-K that rank metrics are scored over.
            "fused_top_k_ids": query_results[i].fused_top_k_ids if i < len(query_results) else [],
            "answer": query_results[i].answer if i < len(query_results) else "",
        })

    data = {
        "run_date": run_date,
        "dataset_version": dataset_version,
        "generated_at": datetime.now().isoformat(timespec='seconds'),
        "total_questions": len(questions),
        "aggregate": {
            "retrieval": asdict(retrieval),
            "generation": asdict(generation),
            "refusal": asdict(refusal) if refusal else None,
        },
        "diagnostic": {
            "overall_health": diagnostic.overall_health.value,
            "findings": [
                {
                    "severity": f.severity.value,
                    "layer": f.layer.value,
                    "title": f.title,
                    "detail": f.detail,
                    "suggested_actions": f.suggested_actions,
                }
                for f in diagnostic.findings
            ],
        },
        "per_question": per_question,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
