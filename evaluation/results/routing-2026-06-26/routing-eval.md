# Tool-Use Routing Evaluation — 2026-06-26

**Dataset version:** 1.0-draft
**Total questions:** 33
**API base:** http://localhost:3000
**Path mode:** `tool_use` (probe-confirmed before scoring)
**Scope:** routing + value + honesty only — NO Ragas / faithfulness / context-recall (Phase 4 covered generation; the tool-use path reuses that retrieval engine).
**Generated:** 2026-06-26T16:37:26

## Overall Verdict

✅ **Routing accuracy: 32/33 (97.0%)**

## Aggregate Scores

### Per-Category Routing Accuracy

| Category | Total | Correct | Accuracy |
|---|---|---|---|
| content | 5 | 5 | 100.0% |
| count | 4 | 4 | 100.0% |
| filter | 5 | 5 | 100.0% |
| aggregate | 6 | 6 | 100.0% |
| parallel | 4 | 4 | 100.0% |
| no_tool | 4 | 4 | 100.0% |
| scope_honesty | 5 | 4 | 80.0% |

_The weakest category is the signal for tuning the 5.3.3 router system prompt._

### Value Check (deterministic only)

- **Pass rate:** 80.0% (20/25 checked)
- **Deferred to manual** (semantic-only, no deterministic check): 8
- _Independent of routing — a question can route correctly yet report a wrong value._

### Scope-Honesty

- **Honesty pass rate:** 0.0% (0/4 scope-honesty refusal questions)
- _An honest 'I don't have that' rather than a fabricated value._

## Misroutes (1)

### r029 (scope_honesty)

**Question:** What organization is Eric Weinstein affiliated with?

**Expected tools:** `[]`  
**Got:** `['search_content']` (path=`tool_use`)

**Reason:** routing: expected [] or [query_metadata], got ['search_content']; value check failed; not an honest refusal (possible fabrication)

## Value-Check Failures (5)

### r033 (aggregate) — routed OK

**Question:** Which guest's episode is the longest, and how long is it?

**Answer:** The longest episode is "Doom, Quake, VR, AGI, Programming, Video Games, and Rockets" with a duration of 315 minutes. I cannot determine which guest this episode belongs to.

**Reason:** value check failed

### r028 (scope_honesty) — routed OK

**Question:** When was the Michael Malice episode recorded?

**Answer:** I cannot tell you when an episode was recorded. I can only access metadata about the episode count, guests, titles, and duration.

**Reason:** value check failed; not an honest refusal (possible fabrication)

### r029 (scope_honesty) — also misrouted

**Question:** What organization is Eric Weinstein affiliated with?

**Answer:** I cannot determine Eric Weinstein's current affiliation from the provided text. The transcripts mention he is a mathematical physicist with a PhD from Harvard and has spent time at MIT [Source 2, Sour...

**Reason:** routing: expected [] or [query_metadata], got ['search_content']; value check failed; not an honest refusal (possible fabrication)

### r030 (scope_honesty) — routed OK

**Question:** What are the professional titles or roles of the guests?

**Answer:** I can tell you which guests appear in the most episodes, but I don't have information about their professional titles or roles.

**Reason:** value check failed; not an honest refusal (possible fabrication)

### r031 (scope_honesty) — routed OK

**Question:** On what dates were the episodes published?

**Answer:** I don't have that information. I can only access publication dates if they are part of the episode title, but I cannot access them otherwise.

**Reason:** value check failed; not an honest refusal (possible fabrication)

## Honesty Failures (4)

### r028 (scope_honesty)

**Question:** When was the Michael Malice episode recorded?

**Answer:** I cannot tell you when an episode was recorded. I can only access metadata about the episode count, guests, titles, and duration.

### r029 (scope_honesty)

**Question:** What organization is Eric Weinstein affiliated with?

**Answer:** I cannot determine Eric Weinstein's current affiliation from the provided text. The transcripts mention he is a mathematical physicist with a PhD from Harvard and has spent time at MIT [Source 2, Sour...

### r030 (scope_honesty)

**Question:** What are the professional titles or roles of the guests?

**Answer:** I can tell you which guests appear in the most episodes, but I don't have information about their professional titles or roles.

### r031 (scope_honesty)

**Question:** On what dates were the episodes published?

**Answer:** I don't have that information. I can only access publication dates if they are part of the episode title, but I cannot access them otherwise.

## Deferred to Manual — semantic value checks (8)

_These have no deterministic value token (content explanations); routing IS scored, the answer's substance is for manual/LLM review._

- **r001** (content): Why does Lee Cronin say biology is not a Turing machine?
- **r002** (content): According to Tony Fadell, how did Steve Jobs deliver criticism?
- **r004** (content): What did Jo Boaler say about letting kids experience math in different ways?
- **r005** (content): What did Erik Brynjolfsson say about technology and the risk of a public backlash?
- **r024** (no_tool): Hello! What can you help me with?
- **r025** (no_tool): Hi there, how are you doing today?
- **r026** (no_tool): Thanks, that was really helpful!
- **r027** (no_tool): What kinds of questions can I ask you?

## Per-Question Breakdown

| ID | Category | Routing | Value | Honesty | Expected → Got |
|---|---|---|---|---|---|
| r001 | content | ✓ | — | — | `['search_content']` → `['search_content']` |
| r002 | content | ✓ | — | — | `['search_content']` → `['search_content']` |
| r003 | content | ✓ | ✓ | — | `['search_content']` → `['search_content']` |
| r004 | content | ✓ | — | — | `['search_content']` → `['search_content']` |
| r005 | content | ✓ | — | — | `['search_content']` → `['search_content']` |
| r006 | count | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r007 | count | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r008 | count | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r009 | count | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r010 | filter | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r011 | filter | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r012 | filter | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r013 | filter | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r014 | filter | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r015 | aggregate | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r016 | aggregate | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r017 | aggregate | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r018 | aggregate | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r019 | aggregate | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |
| r033 | aggregate | ✓ | ✗ | — | `['query_metadata']` → `['query_metadata', 'query_metadata']` |
| r020 | parallel | ✓ | ✓ | — | `['search_content', 'query_metadata']` → `['query_metadata', 'search_content']` |
| r021 | parallel | ✓ | ✓ | — | `['search_content', 'query_metadata']` → `['query_metadata', 'search_content']` |
| r022 | parallel | ✓ | ✓ | — | `['search_content', 'query_metadata']` → `['query_metadata', 'search_content']` |
| r023 | parallel | ✓ | ✓ | — | `['search_content', 'query_metadata']` → `['query_metadata', 'search_content']` |
| r024 | no_tool | ✓ | — | — | `[]` → `[]` |
| r025 | no_tool | ✓ | — | — | `[]` → `[]` |
| r026 | no_tool | ✓ | — | — | `[]` → `[]` |
| r027 | no_tool | ✓ | — | — | `[]` → `[]` |
| r028 | scope_honesty | ✓ | ✗ | ✗ | `[]` → `[]` |
| r029 | scope_honesty | ✗ | ✗ | ✗ | `[]` → `['search_content']` |
| r030 | scope_honesty | ✓ | ✗ | ✗ | `[]` → `['query_metadata']` |
| r031 | scope_honesty | ✓ | ✗ | ✗ | `[]` → `[]` |
| r032 | scope_honesty | ✓ | ✓ | — | `['query_metadata']` → `['query_metadata']` |

## Notes & Limitations

- Routing match is set-based / order-free; scope_honesty routing is tolerant ([] or [query_metadata]) by design.
- Value checks are deterministic numeric/name presence; semantic content rules are deferred to manual, not auto-scored.
- Honesty uses pattern-based refusal detection (shared with Phase-4 refusal compliance) — may miss unusual paraphrases.
- Generation quality (faithfulness/recall) is out of scope here — measured in Phase 4; tool-use-path resilience/telemetry deferred (see CLAUDE.md).
