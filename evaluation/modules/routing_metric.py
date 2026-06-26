"""Deterministic tool-use routing-accuracy metric (Phase 5.5).

Scores the `expected_tools` labels in tool-routing-dataset.json against the
`tool_used` the router reported (api_client.QueryResult.tool_used). Two
INDEPENDENT dimensions per question:

  1. routing_pass — did the router pick the right tool(s)? Set-based, order-free.
     Per-category rules (see `match_routing`). scope_honesty is special: its
     routing is tolerant ([] OR [query_metadata]) because the scored signal there
     is HONESTY, not tool choice.
  2. value_pass — given expected_value_or_check, does the answer satisfy it?
     Deterministic for numeric/name checks (counts, exact-match filters,
     aggregates, the tie-tolerant group_by sets, the count-all tolerance case);
     None when the check is purely semantic prose (content explanations) that
     needs an LLM/manual judge — those are NOT faked here.

scope_honesty additionally carries honesty_pass (a refusal-shaped, non-fabricated
answer), reusing refusal_metric's pattern family so an answer that the system's
output-validation accepts as a refusal is recognized here too.

Pure and deterministic given (category, expected_tools, tool_used, answer,
expected_value_or_check) — unit-testable with no network. No report writing here
(that is Step 3).
"""

from dataclasses import dataclass
from typing import Dict, List, Optional
import re

from evaluation.modules.refusal_metric import is_refusal_response


# ============================================================
# Constants — tool names mirror src/modules/tools/tools.constants.ts;
# category names mirror tool-routing-dataset.json's closed `category` vocab.
# ============================================================

SEARCH_CONTENT_TOOL = 'search_content'
QUERY_METADATA_TOOL = 'query_metadata'
ALL_TOOLS = frozenset({SEARCH_CONTENT_TOOL, QUERY_METADATA_TOOL})

CATEGORY_CONTENT = 'content'
CATEGORY_COUNT = 'count'
CATEGORY_FILTER = 'filter'
CATEGORY_AGGREGATE = 'aggregate'
CATEGORY_PARALLEL = 'parallel'
CATEGORY_NO_TOOL = 'no_tool'
CATEGORY_SCOPE_HONESTY = 'scope_honesty'

# Canonical order for stable per-category reporting in Step 3.
ROUTING_CATEGORIES = (
    CATEGORY_CONTENT,
    CATEGORY_COUNT,
    CATEGORY_FILTER,
    CATEGORY_AGGREGATE,
    CATEGORY_PARALLEL,
    CATEGORY_NO_TOOL,
    CATEGORY_SCOPE_HONESTY,
)
_CATEGORY_SET = frozenset(ROUTING_CATEGORIES)


# ============================================================
# Result objects
# ============================================================

@dataclass(frozen=True)
class RoutingCheck:
    """Per-question routing + value result.

    value_pass / honesty_pass are Optional:
      - value_pass is None when the check is purely semantic (no deterministic
        numeric/name token to score) — defer to a judge, don't fake a verdict.
      - honesty_pass is set only for the scope_honesty refusal sub-kind
        (out-of-scope question, expected_tools == []); None otherwise.
    """
    question_id: str
    category: str
    expected_tools: List[str]
    tool_used: List[str]
    routing_pass: bool
    value_pass: Optional[bool]
    honesty_pass: Optional[bool]
    reason: str  # short explanation of any failure; '' when everything passed


@dataclass(frozen=True)
class CategoryRoutingScore:
    """Routing accuracy within one category."""
    category: str
    total: int
    routing_correct: int
    routing_accuracy: float


@dataclass(frozen=True)
class RoutingAccuracyScore:
    """Aggregated routing accuracy + value/honesty pass rates across the dataset."""
    overall_routing_accuracy: float
    total_questions: int
    routing_correct: int
    per_category: Dict[str, CategoryRoutingScore]
    # Value-check pass rate is over questions with a deterministic check only
    # (value_pass is not None); semantic-only questions are excluded.
    value_check_pass_rate: Optional[float]
    value_checked: int
    value_passed: int
    # Honesty pass rate is over the scope_honesty refusal sub-kind only.
    honesty_pass_rate: Optional[float]
    honesty_checked: int
    honesty_passed: int


# ============================================================
# Routing match (dimension 1) — set-based, order-free
# ============================================================

def match_routing(category: str, expected_tools: List[str], tool_used: List[str]) -> bool:
    """Does the router's tool choice match the expectation for this category?

    - scope_honesty: TOLERANT — [] (answer-direct) or [query_metadata]
      (query-then-honest) both pass; the scored signal is honesty, not routing.
    - every other category: exact, order-free set equality against expected_tools
      (content/count/filter/aggregate → one tool; parallel → both; no_tool → none).
    """
    used = set(tool_used)
    if category == CATEGORY_SCOPE_HONESTY:
        return used == set() or used == {QUERY_METADATA_TOOL}
    return used == set(expected_tools)


# ============================================================
# Value check (dimension 2) — deterministic numeric/name presence
# ============================================================

# A number to verify is "required" only when it follows `contains` or `=` in the
# check string (e.g. "answer contains 319", "= 4"). Numbers in other parentheticals
# (episode_id 309, "[Source 1]") are NOT requirements and are ignored.
_CONTAINS_NUMBER = re.compile(r'(?:contains|=)\s*~?(\d+(?:\.\d+)?)', re.IGNORECASE)
# Optional tolerance band, e.g. "accept 59-60".
_ACCEPT_RANGE = re.compile(r'accept\s+(\d+)\s*-\s*(\d+)', re.IGNORECASE)
# A required name is a sequence of 2+ capitalized words (First Last), e.g.
# "Eric Weinstein", "John Carmack". Quoted substrings (episode titles) are
# stripped first so title words don't leak in as names.
_PROPER_NAME = re.compile(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b')
_QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")


def _required_number_groups(check: str) -> List[set]:
    """Required-number groups; each is a set of acceptable string tokens (the
    number plus any tolerance-band integers). The answer must contain at least
    one token from EVERY group."""
    numbers = _CONTAINS_NUMBER.findall(check)
    if not numbers:
        return []
    groups = [{n} for n in numbers]
    rng = _ACCEPT_RANGE.search(check)
    if rng:
        lo, hi = int(rng.group(1)), int(rng.group(2))
        tolerance = {str(i) for i in range(lo, hi + 1)}
        for g in groups:
            g.update(tolerance)
    return groups


def _required_names(check: str) -> List[str]:
    """Proper names the answer must reference. Quoted titles are stripped first."""
    cleaned = _QUOTED.sub(' ', check)
    return _PROPER_NAME.findall(cleaned)


def _answer_contains_number(answer: str, token: str) -> bool:
    """Whole-number presence: `315` matches "315 minutes" but not "1315"/"3150"."""
    pattern = r'(?<![\d.])' + re.escape(token) + r'(?!\d)'
    return re.search(pattern, answer) is not None


def _answer_contains_text(answer: str, text: str) -> bool:
    return text.lower() in answer.lower()


def check_honesty(answer: str) -> bool:
    """Honest scope-refusal: a refusal-shaped answer (reusing refusal_metric's
    patterns). A fabricated specific value will NOT match → False."""
    return is_refusal_response(answer)


def check_value(
    category: str,
    expected_tools: List[str],
    answer: str,
    expected_value_or_check: str,
) -> Optional[bool]:
    """Verify the answer satisfies expected_value_or_check (independent of routing).

    Returns None when no deterministic token (number or proper name) can be
    extracted — i.e. a purely semantic content rule that needs a judge.
    """
    # scope_honesty refusal sub-kind (out-of-scope, no expected tool): the value
    # signal IS honesty — answer must be an honest refusal, not a fabricated fact.
    if category == CATEGORY_SCOPE_HONESTY and not expected_tools:
        return check_honesty(answer)

    number_groups = _required_number_groups(expected_value_or_check)
    names = _required_names(expected_value_or_check)

    if not number_groups and not names:
        return None  # semantic-only — defer to LLM/manual judge

    passed = True
    if number_groups:
        passed = passed and all(
            any(_answer_contains_number(answer, tok) for tok in group)
            for group in number_groups
        )
    if names:
        if len(names) >= 2:
            # Tie-tolerant (group_by ties): ANY of the listed names is acceptable.
            passed = passed and any(_answer_contains_text(answer, n) for n in names)
        else:
            # Single required name (e.g. the non-tied max episode's guest).
            passed = passed and _answer_contains_text(answer, names[0])
    return passed


# ============================================================
# Per-question scorer
# ============================================================

def score_routing_question(
    question_id: str,
    category: str,
    expected_tools: List[str],
    tool_used: List[str],
    answer: str,
    expected_value_or_check: str,
) -> RoutingCheck:
    """Score one question on both dimensions. Pure; no I/O.

    Raises ValueError on an unknown category (fail loud — mirrors dataset.py).
    """
    if category not in _CATEGORY_SET:
        raise ValueError(f"Unknown routing category '{category}' for {question_id}")

    routing_pass = match_routing(category, expected_tools, tool_used)
    value_pass = check_value(category, expected_tools, answer, expected_value_or_check)

    honesty_pass: Optional[bool] = None
    if category == CATEGORY_SCOPE_HONESTY and not expected_tools:
        honesty_pass = check_honesty(answer)

    reason = _build_reason(
        category, expected_tools, tool_used, routing_pass, value_pass, honesty_pass
    )

    return RoutingCheck(
        question_id=question_id,
        category=category,
        expected_tools=list(expected_tools),
        tool_used=list(tool_used),
        routing_pass=routing_pass,
        value_pass=value_pass,
        honesty_pass=honesty_pass,
        reason=reason,
    )


def _build_reason(
    category: str,
    expected_tools: List[str],
    tool_used: List[str],
    routing_pass: bool,
    value_pass: Optional[bool],
    honesty_pass: Optional[bool],
) -> str:
    """Short, human-readable explanation of any failure ('' when all pass)."""
    parts: List[str] = []
    if not routing_pass:
        if category == CATEGORY_SCOPE_HONESTY:
            expected_desc = "[] or [query_metadata]"
        else:
            expected_desc = str(sorted(expected_tools))
        parts.append(f"routing: expected {expected_desc}, got {sorted(tool_used)}")
    if value_pass is False:
        parts.append("value check failed")
    if honesty_pass is False:
        parts.append("not an honest refusal (possible fabrication)")
    return "; ".join(parts)


# ============================================================
# Aggregate
# ============================================================

def aggregate_routing(checks: List[RoutingCheck]) -> RoutingAccuracyScore:
    """Aggregate per-question checks into overall + per-category routing accuracy,
    plus value-check and honesty pass rates.

    Raises ValueError on an empty input list.
    """
    if not checks:
        raise ValueError("No routing checks to aggregate")

    total = len(checks)
    routing_correct = sum(1 for c in checks if c.routing_pass)

    per_category: Dict[str, CategoryRoutingScore] = {}
    for category in ROUTING_CATEGORIES:
        cat_checks = [c for c in checks if c.category == category]
        if not cat_checks:
            continue
        correct = sum(1 for c in cat_checks if c.routing_pass)
        per_category[category] = CategoryRoutingScore(
            category=category,
            total=len(cat_checks),
            routing_correct=correct,
            routing_accuracy=correct / len(cat_checks),
        )

    value_checks = [c for c in checks if c.value_pass is not None]
    value_passed = sum(1 for c in value_checks if c.value_pass)
    value_rate = (value_passed / len(value_checks)) if value_checks else None

    honesty_checks = [c for c in checks if c.honesty_pass is not None]
    honesty_passed = sum(1 for c in honesty_checks if c.honesty_pass)
    honesty_rate = (honesty_passed / len(honesty_checks)) if honesty_checks else None

    return RoutingAccuracyScore(
        overall_routing_accuracy=routing_correct / total,
        total_questions=total,
        routing_correct=routing_correct,
        per_category=per_category,
        value_check_pass_rate=value_rate,
        value_checked=len(value_checks),
        value_passed=value_passed,
        honesty_pass_rate=honesty_rate,
        honesty_checked=len(honesty_checks),
        honesty_passed=honesty_passed,
    )
