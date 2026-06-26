"""Report writer for the Phase 5.5 tool-use routing evaluation.

Pure functions — no I/O, no network. `build_markdown_report` returns a string and
`build_json_report` returns a dict; the runner writes them to disk. Kept separate
from report.py (Phase-4 Ragas report) since the dimensions are different (routing /
value / honesty, no faithfulness/recall).

Questions are duck-typed (id, category, question, expected_tools, ground_truth) to
avoid importing the runner's RoutingQuestion (circular import); query_results are
api_client.QueryResult (answer, tool_used, path).
"""

from datetime import datetime
from typing import Dict, List, Optional

from evaluation.modules.api_client import QueryResult
from evaluation.modules.routing_metric import (
    ROUTING_CATEGORIES,
    RoutingAccuracyScore,
    RoutingCheck,
)


# Routing-accuracy verdict thresholds.
_HEALTHY_THRESHOLD = 0.90
_WARNING_THRESHOLD = 0.75

_EXCERPT_LEN = 200


# ============================================================
# Pure formatters (unit-tested directly)
# ============================================================

def format_misroutes(
    questions: list,
    query_results: List[QueryResult],
    checks: List[RoutingCheck],
) -> List[dict]:
    """Every routing failure: id, category, question, expected vs got, reason."""
    out = []
    for q, r, c in zip(questions, query_results, checks):
        if c.routing_pass:
            continue
        out.append({
            "id": c.question_id,
            "category": c.category,
            "question": q.question,
            "expected_tools": list(c.expected_tools),
            "tool_used": list(c.tool_used),
            "path": r.path,
            "reason": c.reason,
        })
    return out


def format_value_failures(
    questions: list,
    query_results: List[QueryResult],
    checks: List[RoutingCheck],
) -> List[dict]:
    """Deterministic value-check failures (value_pass is False) — note these are
    INDEPENDENT of routing: a question can route correctly yet report a wrong value."""
    out = []
    for q, r, c in zip(questions, query_results, checks):
        if c.value_pass is not False:
            continue
        out.append({
            "id": c.question_id,
            "category": c.category,
            "question": q.question,
            "routing_pass": c.routing_pass,
            "answer_excerpt": _excerpt(r.answer),
            "reason": c.reason,
        })
    return out


def format_honesty_failures(
    questions: list,
    query_results: List[QueryResult],
    checks: List[RoutingCheck],
) -> List[dict]:
    """scope_honesty answers that failed the honest-refusal check (possible fabrication)."""
    out = []
    for q, r, c in zip(questions, query_results, checks):
        if c.honesty_pass is not False:
            continue
        out.append({
            "id": c.question_id,
            "category": c.category,
            "question": q.question,
            "answer_excerpt": _excerpt(r.answer),
        })
    return out


def format_deferred(questions: list, checks: List[RoutingCheck]) -> List[dict]:
    """Semantic-only questions (value_pass is None) — flagged for manual review,
    NOT counted pass/fail."""
    out = []
    for q, c in zip(questions, checks):
        if c.value_pass is not None:
            continue
        out.append({
            "id": c.question_id,
            "category": c.category,
            "question": q.question,
        })
    return out


# ============================================================
# Markdown report
# ============================================================

def build_markdown_report(
    run_date: str,
    dataset_version: str,
    aggregate: RoutingAccuracyScore,
    questions: list,
    query_results: List[QueryResult],
    checks: List[RoutingCheck],
    failed_count: int,
    api_base: str,
) -> str:
    """Assemble the human-readable routing report."""
    lines: List[str] = []

    # 1. Header
    lines.append(f"# Tool-Use Routing Evaluation — {run_date}\n")
    lines.append(f"**Dataset version:** {dataset_version}")
    lines.append(f"**Total questions:** {aggregate.total_questions}")
    lines.append(f"**API base:** {api_base}")
    lines.append("**Path mode:** `tool_use` (probe-confirmed before scoring)")
    lines.append("**Scope:** routing + value + honesty only — NO Ragas / faithfulness / "
                 "context-recall (Phase 4 covered generation; the tool-use path reuses "
                 "that retrieval engine).")
    lines.append(f"**Generated:** {datetime.now().isoformat(timespec='seconds')}\n")

    # 2. Overall verdict
    acc = aggregate.overall_routing_accuracy
    lines.append("## Overall Verdict\n")
    lines.append(f"{_verdict(acc)} **Routing accuracy: "
                 f"{aggregate.routing_correct}/{aggregate.total_questions} "
                 f"({acc * 100:.1f}%)**")
    if failed_count:
        lines.append(f"\n_⚠ {failed_count} question(s) failed to query (counted as misroutes)._")
    lines.append("")

    # 3. Aggregate scores
    lines.append("## Aggregate Scores\n")

    lines.append("### Per-Category Routing Accuracy\n")
    lines.append("| Category | Total | Correct | Accuracy |")
    lines.append("|---|---|---|---|")
    for category in ROUTING_CATEGORIES:
        cat = aggregate.per_category.get(category)
        if cat is None:
            continue
        lines.append(f"| {category} | {cat.total} | {cat.routing_correct} | "
                     f"{cat.routing_accuracy * 100:.1f}% |")
    lines.append("")
    lines.append("_The weakest category is the signal for tuning the 5.3.3 router "
                 "system prompt._\n")

    lines.append("### Value Check (deterministic only)\n")
    lines.append(f"- **Pass rate:** {_fmt_rate(aggregate.value_check_pass_rate)} "
                 f"({aggregate.value_passed}/{aggregate.value_checked} checked)")
    deferred = aggregate.total_questions - aggregate.value_checked
    lines.append(f"- **Deferred to manual** (semantic-only, no deterministic check): "
                 f"{deferred}")
    lines.append("- _Independent of routing — a question can route correctly yet report "
                 "a wrong value._\n")

    lines.append("### Scope-Honesty\n")
    lines.append(f"- **Honesty pass rate:** {_fmt_rate(aggregate.honesty_pass_rate)} "
                 f"({aggregate.honesty_passed}/{aggregate.honesty_checked} scope-honesty "
                 "refusal questions)")
    lines.append("- _An honest 'I don't have that' rather than a fabricated value._\n")

    # 4. Misroutes
    misroutes = format_misroutes(questions, query_results, checks)
    lines.append(f"## Misroutes ({len(misroutes)})\n")
    if not misroutes:
        lines.append("_None — every question routed correctly._\n")
    else:
        for m in misroutes:
            lines.append(f"### {m['id']} ({m['category']})\n")
            lines.append(f"**Question:** {m['question']}\n")
            lines.append(f"**Expected tools:** `{m['expected_tools']}`  ")
            lines.append(f"**Got:** `{m['tool_used']}` (path=`{m['path']}`)\n")
            lines.append(f"**Reason:** {m['reason']}\n")

    # 5. Value-check failures (routed right, wrong value)
    value_failures = format_value_failures(questions, query_results, checks)
    lines.append(f"## Value-Check Failures ({len(value_failures)})\n")
    if not value_failures:
        lines.append("_None — every deterministic value check passed._\n")
    else:
        for v in value_failures:
            routed = "routed OK" if v["routing_pass"] else "also misrouted"
            lines.append(f"### {v['id']} ({v['category']}) — {routed}\n")
            lines.append(f"**Question:** {v['question']}\n")
            lines.append(f"**Answer:** {v['answer_excerpt']}\n")
            lines.append(f"**Reason:** {v['reason']}\n")

    # 6. Honesty failures
    honesty_failures = format_honesty_failures(questions, query_results, checks)
    lines.append(f"## Honesty Failures ({len(honesty_failures)})\n")
    if not honesty_failures:
        lines.append("_None — every scope-honesty question refused honestly._\n")
    else:
        for h in honesty_failures:
            lines.append(f"### {h['id']} ({h['category']})\n")
            lines.append(f"**Question:** {h['question']}\n")
            lines.append(f"**Answer:** {h['answer_excerpt']}\n")

    # 7. Deferred to manual
    deferred_list = format_deferred(questions, checks)
    lines.append(f"## Deferred to Manual — semantic value checks ({len(deferred_list)})\n")
    if not deferred_list:
        lines.append("_None._\n")
    else:
        lines.append("_These have no deterministic value token (content explanations); "
                     "routing IS scored, the answer's substance is for manual/LLM review._\n")
        for d in deferred_list:
            lines.append(f"- **{d['id']}** ({d['category']}): {d['question']}")
        lines.append("")

    # 8. Per-question breakdown
    lines.append("## Per-Question Breakdown\n")
    lines.append("| ID | Category | Routing | Value | Honesty | Expected → Got |")
    lines.append("|---|---|---|---|---|---|")
    for q, r, c in zip(questions, query_results, checks):
        lines.append(
            f"| {c.question_id} | {c.category} | {_pf(c.routing_pass)} | "
            f"{_pf(c.value_pass)} | {_pf(c.honesty_pass)} | "
            f"`{c.expected_tools}` → `{c.tool_used}` |"
        )
    lines.append("")

    # 9. Notes
    lines.append("## Notes & Limitations\n")
    lines.append("- Routing match is set-based / order-free; scope_honesty routing is "
                 "tolerant ([] or [query_metadata]) by design.")
    lines.append("- Value checks are deterministic numeric/name presence; semantic content "
                 "rules are deferred to manual, not auto-scored.")
    lines.append("- Honesty uses pattern-based refusal detection (shared with Phase-4 "
                 "refusal compliance) — may miss unusual paraphrases.")
    lines.append("- Generation quality (faithfulness/recall) is out of scope here — measured "
                 "in Phase 4; tool-use-path resilience/telemetry deferred (see CLAUDE.md).\n")

    return "\n".join(lines)


# ============================================================
# JSON report
# ============================================================

def build_json_report(
    run_date: str,
    dataset_version: str,
    aggregate: RoutingAccuracyScore,
    questions: list,
    query_results: List[QueryResult],
    checks: List[RoutingCheck],
) -> dict:
    """Machine-readable report for cross-run comparison."""
    per_category = {
        cat: {
            "total": score.total,
            "routing_correct": score.routing_correct,
            "routing_accuracy": score.routing_accuracy,
        }
        for cat, score in aggregate.per_category.items()
    }

    per_question = []
    for q, r, c in zip(questions, query_results, checks):
        per_question.append({
            "id": c.question_id,
            "category": c.category,
            "question": q.question,
            "expected_tools": list(c.expected_tools),
            "tool_used": list(c.tool_used),
            "path": r.path,
            "routing_pass": c.routing_pass,
            "value_pass": c.value_pass,
            "honesty_pass": c.honesty_pass,
            "reason": c.reason,
            "answer": r.answer,
        })

    return {
        "run_date": run_date,
        "dataset_version": dataset_version,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "scope": "routing+value+honesty (no ragas/faithfulness)",
        "aggregate": {
            "overall_routing_accuracy": aggregate.overall_routing_accuracy,
            "total_questions": aggregate.total_questions,
            "routing_correct": aggregate.routing_correct,
            "per_category": per_category,
            "value_check_pass_rate": aggregate.value_check_pass_rate,
            "value_checked": aggregate.value_checked,
            "value_passed": aggregate.value_passed,
            "honesty_pass_rate": aggregate.honesty_pass_rate,
            "honesty_checked": aggregate.honesty_checked,
            "honesty_passed": aggregate.honesty_passed,
        },
        "misroutes": format_misroutes(questions, query_results, checks),
        "value_failures": format_value_failures(questions, query_results, checks),
        "honesty_failures": format_honesty_failures(questions, query_results, checks),
        "deferred_to_manual": format_deferred(questions, checks),
        "per_question": per_question,
    }


# ============================================================
# Small helpers
# ============================================================

def _verdict(accuracy: float) -> str:
    if accuracy >= _HEALTHY_THRESHOLD:
        return "✅"
    if accuracy >= _WARNING_THRESHOLD:
        return "⚠️"
    return "🔴"


def _pf(value: Optional[bool]) -> str:
    """Pass/fail/not-applicable cell."""
    if value is None:
        return "—"
    return "✓" if value else "✗"


def _fmt_rate(value: Optional[float]) -> str:
    return "N/A" if value is None else f"{value * 100:.1f}%"


def _excerpt(answer: str) -> str:
    if len(answer) > _EXCERPT_LEN:
        return answer[:_EXCERPT_LEN] + "..."
    return answer
