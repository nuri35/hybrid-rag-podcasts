"""Unit tests for the Phase 5.5 routing-accuracy scorer (no network)."""

import pytest

from evaluation.modules.routing_metric import (
    SEARCH_CONTENT_TOOL,
    QUERY_METADATA_TOOL,
    CATEGORY_CONTENT,
    CATEGORY_COUNT,
    CATEGORY_FILTER,
    CATEGORY_AGGREGATE,
    CATEGORY_PARALLEL,
    CATEGORY_NO_TOOL,
    CATEGORY_SCOPE_HONESTY,
    match_routing,
    check_value,
    check_honesty,
    score_routing_question,
    aggregate_routing,
)


# Real expected_value_or_check strings copied from tool-routing-dataset.json so the
# extraction is tested against the actual prose it must parse.
CHECK_R006 = "answer contains 319 (aggregation_type=count, no filter)"
CHECK_R010 = "answer contains 4 (count or filter where guest_name == 'Michael Malice')"
CHECK_R017 = ("answer contains ~59.75 (accept 59-60, rounding tolerant) — "
              "aggregation_type=avg over duration_min")
CHECK_R018 = ("answer reflects the top count of 4; a 3-way tie (Eric Weinstein, "
              "Manolis Kellis, Michael Malice) — accept naming any/all of the three "
              "at 4 episodes")
CHECK_R019 = ("answer lists the top guests at 4 episodes each (Eric Weinstein, "
              "Manolis Kellis, Michael Malice) — group_by guest_name, top buckets")
CHECK_R033 = ("answer names John Carmack and contains 315 (minutes); episode is "
              "'Doom, Quake, VR, AGI, Programming, Video Games, and Rockets' "
              "(episode_id 309) — single, non-tied max over duration_min")
CHECK_R003 = "answer names Roger Penrose"
CHECK_R001 = ("answer explains that Turing machines don't evolve, whereas biology "
              "evolved (and eventually produced Turing himself)")
CHECK_R032 = ("answer contains 319 and the request succeeds with NO error "
              "(count-all tolerance: ...)")


# ============================================================
# Dimension 1 — routing match per category (correct + wrong)
# ============================================================

def test_content_routing_correct_and_wrong():
    assert match_routing(CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL], [SEARCH_CONTENT_TOOL]) is True
    # Content question that wrongly routed to query_metadata.
    assert match_routing(CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL], [QUERY_METADATA_TOOL]) is False


def test_count_routing_correct_and_wrong():
    assert match_routing(CATEGORY_COUNT, [QUERY_METADATA_TOOL], [QUERY_METADATA_TOOL]) is True
    assert match_routing(CATEGORY_COUNT, [QUERY_METADATA_TOOL], [SEARCH_CONTENT_TOOL]) is False


def test_filter_routing_correct_and_wrong():
    assert match_routing(CATEGORY_FILTER, [QUERY_METADATA_TOOL], [QUERY_METADATA_TOOL]) is True
    assert match_routing(CATEGORY_FILTER, [QUERY_METADATA_TOOL], []) is False


def test_aggregate_routing_correct_and_wrong():
    assert match_routing(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], [QUERY_METADATA_TOOL]) is True
    # Aggregate that wrongly also fired search_content (over-routing).
    assert match_routing(
        CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL],
        [QUERY_METADATA_TOOL, SEARCH_CONTENT_TOOL],
    ) is False


def test_routing_is_order_free():
    expected = [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL]
    used_reversed = [QUERY_METADATA_TOOL, SEARCH_CONTENT_TOOL]
    assert match_routing(CATEGORY_PARALLEL, expected, used_reversed) is True


# ============================================================
# parallel — both present passes, only one present fails
# ============================================================

def test_parallel_both_present_passes():
    assert match_routing(
        CATEGORY_PARALLEL,
        [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL],
        [QUERY_METADATA_TOOL, SEARCH_CONTENT_TOOL],
    ) is True


def test_parallel_only_one_present_fails():
    assert match_routing(
        CATEGORY_PARALLEL, [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL], [SEARCH_CONTENT_TOOL]
    ) is False
    assert match_routing(
        CATEGORY_PARALLEL, [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL], [QUERY_METADATA_TOOL]
    ) is False


# ============================================================
# no_tool — [] passes, any tool fails
# ============================================================

def test_no_tool_empty_passes_any_tool_fails():
    assert match_routing(CATEGORY_NO_TOOL, [], []) is True
    assert match_routing(CATEGORY_NO_TOOL, [], [SEARCH_CONTENT_TOOL]) is False
    assert match_routing(CATEGORY_NO_TOOL, [], [QUERY_METADATA_TOOL]) is False


# ============================================================
# scope_honesty — tolerant routing + honesty dimension
# ============================================================

def test_scope_honesty_routing_tolerates_empty_and_query_metadata():
    assert match_routing(CATEGORY_SCOPE_HONESTY, [], []) is True
    assert match_routing(CATEGORY_SCOPE_HONESTY, [], [QUERY_METADATA_TOOL]) is True
    # Routing to search_content is NOT acceptable for a scope-honesty question.
    assert match_routing(CATEGORY_SCOPE_HONESTY, [], [SEARCH_CONTENT_TOOL]) is False


def test_scope_honesty_honesty_pass_true_on_refusal():
    honest = "The sources do not contain information about episode dates."
    assert check_honesty(honest) is True


def test_scope_honesty_honesty_pass_false_on_fabrication():
    fabricated = "Eric Weinstein is affiliated with the Thiel Foundation."
    assert check_honesty(fabricated) is False


def test_scope_honesty_question_scores_honesty_and_value_together():
    # Honest refusal: routing tolerant, honesty True, value (== honesty) True.
    ok = score_routing_question(
        "r029", CATEGORY_SCOPE_HONESTY, [], [],
        "I don't have that information — the sources do not contain affiliation data.",
        "honest no-info; MUST NOT fabricate",
    )
    assert ok.routing_pass is True
    assert ok.honesty_pass is True
    assert ok.value_pass is True
    assert ok.reason == ""

    # Fabricated answer: honesty False, value False, reason flags fabrication.
    bad = score_routing_question(
        "r029", CATEGORY_SCOPE_HONESTY, [], [QUERY_METADATA_TOOL],
        "Eric Weinstein works at Thiel Capital.",
        "honest no-info; MUST NOT fabricate",
    )
    assert bad.routing_pass is True            # routing still tolerant
    assert bad.honesty_pass is False
    assert bad.value_pass is False
    assert "honest refusal" in bad.reason


# ============================================================
# Dimension 2 — value check (numeric / name / tie / semantic)
# ============================================================

def test_value_contains_number_pass_and_fail():
    assert check_value(CATEGORY_COUNT, [QUERY_METADATA_TOOL],
                       "There are 319 episodes in total.", CHECK_R006) is True
    # Wrong number reported.
    assert check_value(CATEGORY_COUNT, [QUERY_METADATA_TOOL],
                       "There are 300 episodes.", CHECK_R006) is False


def test_value_number_is_whole_token_not_substring():
    # "319" must not match inside "13190".
    assert check_value(CATEGORY_COUNT, [QUERY_METADATA_TOOL],
                       "Catalog id 13190 only.", CHECK_R006) is False


def test_value_avg_tolerance_band_accepts_rounded():
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL],
                       "The average duration is about 59.75 minutes.", CHECK_R017) is True
    # Within the accept 59-60 band.
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL],
                       "Episodes average roughly 60 minutes.", CHECK_R017) is True
    # Out of band.
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL],
                       "Episodes average about 45 minutes.", CHECK_R017) is False


def test_value_tie_tolerant_accepts_any_tied_guest():
    # r018/r019: naming ANY one of the three tied guests passes.
    for guest in ("Eric Weinstein", "Manolis Kellis", "Michael Malice"):
        ans = f"The most frequent guest is {guest}, with 4 episodes."
        assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], ans, CHECK_R018) is True
        assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], ans, CHECK_R019) is True


def test_value_tie_tolerant_fails_when_no_tied_guest_named():
    ans = "The most frequent guest is Andrew Huberman."
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], ans, CHECK_R018) is False


def test_value_non_tied_r033_requires_exact_name_and_number():
    good = ("The longest episode is John Carmack's, at 315 minutes.")
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], good, CHECK_R033) is True
    # Right number, wrong/missing guest.
    missing_name = "The longest episode runs 315 minutes."
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], missing_name, CHECK_R033) is False
    # Right guest, wrong number.
    wrong_num = "The longest episode is John Carmack's, at 200 minutes."
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], wrong_num, CHECK_R033) is False


def test_value_title_words_do_not_leak_as_required_names():
    # The quoted title contains "Video Games"; it must NOT become a required name.
    # An answer with the guest + number but NOT the title still passes.
    ans = "John Carmack's episode is the longest at 315 minutes."
    assert check_value(CATEGORY_AGGREGATE, [QUERY_METADATA_TOOL], ans, CHECK_R033) is True


def test_value_content_name_check_is_deterministic():
    assert check_value(CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
                       "Dawkins agrees with Roger Penrose on the mystery.", CHECK_R003) is True
    assert check_value(CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
                       "Dawkins agrees with another physicist.", CHECK_R003) is False


def test_value_semantic_only_content_returns_none():
    # No number, no proper name → not deterministically scorable → None (defer to judge).
    assert check_value(CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
                       "Turing machines don't evolve but biology did.", CHECK_R001) is None


def test_value_filter_exact_match_count():
    assert check_value(CATEGORY_FILTER, [QUERY_METADATA_TOOL],
                       "Michael Malice appears in 4 episodes.", CHECK_R010) is True
    assert check_value(CATEGORY_FILTER, [QUERY_METADATA_TOOL],
                       "Michael Malice appears in 2 episodes.", CHECK_R010) is False


def test_value_count_all_tolerance_case_r032():
    # r032 is in scope_honesty but has expected_tools=[query_metadata] → numeric check, not refusal.
    assert check_value(CATEGORY_SCOPE_HONESTY, [QUERY_METADATA_TOOL],
                       "In total there are 319 episodes.", CHECK_R032) is True


# ============================================================
# Per-question + aggregate
# ============================================================

def test_score_question_content_correct():
    c = score_routing_question(
        "r003", CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL], [SEARCH_CONTENT_TOOL],
        "Dawkins agrees with Roger Penrose.", CHECK_R003,
    )
    assert c.routing_pass is True
    assert c.value_pass is True
    assert c.honesty_pass is None
    assert c.reason == ""


def test_score_question_content_misrouted_reports_reason():
    c = score_routing_question(
        "r003", CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL], [QUERY_METADATA_TOOL],
        "Dawkins agrees with Roger Penrose.", CHECK_R003,
    )
    assert c.routing_pass is False
    assert "routing: expected" in c.reason


def test_unknown_category_raises():
    with pytest.raises(ValueError, match="Unknown routing category"):
        score_routing_question("rXXX", "bogus", [], [], "a", "b")


def test_aggregate_overall_and_per_category_and_rates():
    checks = [
        # content: 1 correct (value pass), 1 misrouted
        score_routing_question("r001", CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
                               [SEARCH_CONTENT_TOOL], "Roger Penrose.", CHECK_R003),
        score_routing_question("r002", CATEGORY_CONTENT, [SEARCH_CONTENT_TOOL],
                               [QUERY_METADATA_TOOL], "Roger Penrose.", CHECK_R003),
        # count: correct + value pass
        score_routing_question("r006", CATEGORY_COUNT, [QUERY_METADATA_TOOL],
                               [QUERY_METADATA_TOOL], "There are 319 episodes.", CHECK_R006),
        # parallel: correct routing, value pass (number 4)
        score_routing_question("r020", CATEGORY_PARALLEL,
                               [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL],
                               [SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL],
                               "He appears in 4 episodes and discussed anarchism.",
                               "answer contains 4 AND summarizes content"),
        # no_tool: correct (value None — semantic)
        score_routing_question("r024", CATEGORY_NO_TOOL, [], [],
                               "Hello! I answer questions about the podcast.",
                               "no tool invoked; brief direct greeting"),
        # scope_honesty: honest refusal
        score_routing_question("r029", CATEGORY_SCOPE_HONESTY, [], [],
                               "The sources do not contain affiliation information.",
                               "honest no-info"),
    ]

    agg = aggregate_routing(checks)

    # Overall: 5 of 6 routed correctly (r002 misrouted).
    assert agg.total_questions == 6
    assert agg.routing_correct == 5
    assert abs(agg.overall_routing_accuracy - 5 / 6) < 1e-9

    # Per-category breakdown.
    assert agg.per_category[CATEGORY_CONTENT].total == 2
    assert agg.per_category[CATEGORY_CONTENT].routing_correct == 1
    assert agg.per_category[CATEGORY_COUNT].routing_accuracy == 1.0
    assert CATEGORY_FILTER not in agg.per_category  # none present

    # Value-check rate is over deterministic checks only. Deterministic here:
    # r001(content,name)=pass, r006(count)=pass, r020(parallel,num)=pass,
    # r029(scope refusal)=pass. r002 value also deterministic (name) = pass.
    # r024 (no_tool) is semantic → excluded.
    assert agg.value_checked == 5
    assert agg.value_passed == 5
    assert agg.value_check_pass_rate == 1.0

    # Honesty rate over scope_honesty refusal sub-kind only (r029).
    assert agg.honesty_checked == 1
    assert agg.honesty_passed == 1
    assert agg.honesty_pass_rate == 1.0


def test_aggregate_empty_raises():
    with pytest.raises(ValueError, match="No routing checks"):
        aggregate_routing([])
