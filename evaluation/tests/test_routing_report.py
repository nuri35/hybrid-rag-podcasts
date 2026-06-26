"""Unit tests for the Phase 5.5 routing runner's pure helpers (no network):
the dataset loader, scoring wiring, and report assembly."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from evaluation.modules.api_client import QueryResult
from evaluation.modules.routing_metric import (
    SEARCH_CONTENT_TOOL,
    QUERY_METADATA_TOOL,
    CATEGORY_CONTENT,
    CATEGORY_COUNT,
    CATEGORY_NO_TOOL,
    CATEGORY_SCOPE_HONESTY,
    score_routing_question,
    aggregate_routing,
)
from evaluation.modules.routing_report import (
    format_misroutes,
    format_value_failures,
    format_honesty_failures,
    format_deferred,
    build_markdown_report,
    build_json_report,
)
from evaluation.run_routing_eval import (
    load_routing_dataset,
    build_routing_checks,
    RoutingQuestion,
)


REAL_DATASET = Path("evaluation/tool-routing-dataset.json")


# ============================================================
# Dataset loader (reads the real file — no network)
# ============================================================

def test_load_real_routing_dataset():
    ds = load_routing_dataset(REAL_DATASET)
    assert ds.total_questions == len(ds.questions) == 33
    # Distribution declared == actual is enforced by the loader; spot-check ids unique.
    ids = [q.id for q in ds.questions]
    assert len(ids) == len(set(ids))
    # Every expected_tools entry is a known tool.
    for q in ds.questions:
        for t in q.expected_tools:
            assert t in (SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL)


def test_loader_rejects_bad_category(tmp_path):
    import json
    bad = {
        "version": "x", "created_at": "y", "total_questions": 1,
        "distribution": {"bogus": 1},
        "questions": [{
            "id": "r001", "category": "bogus", "question": "q",
            "expected_tools": [], "expected_value_or_check": "c",
            "ground_truth": "g", "notes": "n",
        }],
    }
    p = tmp_path / "bad.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid category"):
        load_routing_dataset(p)


def test_loader_rejects_distribution_mismatch(tmp_path):
    import json
    bad = {
        "version": "x", "created_at": "y", "total_questions": 1,
        "distribution": {"content": 5},  # declares 5, but only 1 present
        "questions": [{
            "id": "r001", "category": "content", "question": "q",
            "expected_tools": ["search_content"], "expected_value_or_check": "c",
            "ground_truth": "g", "notes": "n",
        }],
    }
    p = tmp_path / "bad.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError, match="Distribution mismatch"):
        load_routing_dataset(p)


# ============================================================
# Fixtures: a small synthetic run
# ============================================================

def _q(qid, category, expected_tools, question="?", check="answer contains 319", gt="g"):
    return RoutingQuestion(
        id=qid, category=category, question=question,
        expected_tools=list(expected_tools), expected_value_or_check=check,
        ground_truth=gt, notes="n",
    )


def _r(answer, tool_used, path):
    return QueryResult(question="?", answer=answer, sources=[],
                       tool_used=list(tool_used), path=path)


@pytest.fixture
def sample_run():
    questions = [
        _q("r006", CATEGORY_COUNT, [QUERY_METADATA_TOOL],
           "How many episodes?", "answer contains 319"),
        _q("r001", CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
           "What did X say?", "answer explains the idea"),  # semantic → value None
        _q("r024", CATEGORY_NO_TOOL, [],
           "Hello!", "no tool; greeting"),                  # semantic → value None
        _q("r029", CATEGORY_SCOPE_HONESTY, [],
           "Affiliation?", "honest no-info"),
    ]
    results = [
        _r("There are 319 episodes.", [QUERY_METADATA_TOOL], "tool_use"),   # all good
        _r("X explained it.", [QUERY_METADATA_TOOL], "tool_use"),           # MISROUTE
        _r("Hi! I answer podcast questions.", [], "tool_use"),              # good
        _r("The sources do not contain affiliation info.", [], "tool_use"),  # honest
    ]
    checks = build_routing_checks(questions, results)
    return questions, results, checks


# ============================================================
# Scoring wiring + formatters
# ============================================================

def test_build_routing_checks_length_guard():
    with pytest.raises(ValueError, match="Length mismatch"):
        build_routing_checks([_q("r1", CATEGORY_COUNT, [QUERY_METADATA_TOOL])], [])


def test_format_misroutes_only_lists_failures(sample_run):
    questions, results, checks = sample_run
    misroutes = format_misroutes(questions, results, checks)
    assert [m["id"] for m in misroutes] == ["r001"]
    m = misroutes[0]
    assert m["expected_tools"] == [SEARCH_CONTENT_TOOL]
    assert m["tool_used"] == [QUERY_METADATA_TOOL]
    assert "routing" in m["reason"]


def test_format_deferred_lists_semantic_only(sample_run):
    questions, results, checks = sample_run
    deferred = format_deferred(questions, checks)
    # r001 (content semantic) and r024 (no_tool greeting) have value_pass None.
    assert sorted(d["id"] for d in deferred) == ["r001", "r024"]


def test_format_value_and_honesty_failures_empty_when_clean(sample_run):
    questions, results, checks = sample_run
    assert format_value_failures(questions, results, checks) == []
    assert format_honesty_failures(questions, results, checks) == []


def test_honesty_failure_detected():
    questions = [_q("r029", CATEGORY_SCOPE_HONESTY, [], "Affiliation?", "honest no-info")]
    results = [_r("Eric Weinstein works at Thiel Capital.", [QUERY_METADATA_TOOL], "tool_use")]
    checks = build_routing_checks(questions, results)
    hf = format_honesty_failures(questions, results, checks)
    assert [h["id"] for h in hf] == ["r029"]
    vf = format_value_failures(questions, results, checks)
    assert [v["id"] for v in vf] == ["r029"]  # value == honesty for refusal sub-kind


# ============================================================
# Report assembly
# ============================================================

def test_build_markdown_report_smoke(sample_run):
    questions, results, checks = sample_run
    agg = aggregate_routing(checks)
    md = build_markdown_report(
        run_date="2026-06-26", dataset_version="1.0-draft", aggregate=agg,
        questions=questions, query_results=results, checks=checks,
        failed_count=0, api_base="http://localhost:3000",
    )
    assert "# Tool-Use Routing Evaluation — 2026-06-26" in md
    assert "Routing accuracy: 3/4" in md          # r001 misrouted → 3/4
    assert "## Misroutes (1)" in md
    assert "r001" in md
    assert "Per-Category Routing Accuracy" in md
    assert "Deferred to Manual" in md
    # Scope is explicitly disclaimed (the report names what it does NOT measure).
    assert "NO Ragas" in md
    # ...but there is no faithfulness/recall SCORE table.
    assert "| Faithfulness |" not in md


def test_build_json_report_shape(sample_run):
    questions, results, checks = sample_run
    agg = aggregate_routing(checks)
    payload = build_json_report(
        run_date="2026-06-26", dataset_version="1.0-draft", aggregate=agg,
        questions=questions, query_results=results, checks=checks,
    )
    assert payload["aggregate"]["routing_correct"] == 3
    assert payload["aggregate"]["total_questions"] == 4
    assert [m["id"] for m in payload["misroutes"]] == ["r001"]
    assert len(payload["per_question"]) == 4
    # Per-question carries the routing fields the next run can diff on.
    pq = {p["id"]: p for p in payload["per_question"]}
    assert pq["r006"]["routing_pass"] is True
    assert pq["r006"]["value_pass"] is True
    assert pq["r001"]["routing_pass"] is False
    assert pq["r001"]["value_pass"] is None
    assert pq["r029"]["honesty_pass"] is True


def test_report_accepts_duck_typed_questions():
    # Report helpers must not depend on RoutingQuestion specifically.
    q = SimpleNamespace(id="r006", category=CATEGORY_COUNT, question="How many?",
                        expected_tools=[QUERY_METADATA_TOOL], ground_truth="g")
    r = _r("There are 319 episodes.", [QUERY_METADATA_TOOL], "tool_use")
    c = score_routing_question("r006", CATEGORY_COUNT, [QUERY_METADATA_TOOL],
                               [QUERY_METADATA_TOOL], r.answer, "answer contains 319")
    payload = build_json_report("2026-06-26", "v", aggregate_routing([c]),
                                [q], [r], [c])
    assert payload["per_question"][0]["question"] == "How many?"
