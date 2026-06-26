# ADR 0021 — Tool-use pipeline integration: QaFacadeService, shared guards, context-aware output validation

- **Status:** Accepted (Phase 5.4 + 5.5 complete, 2026-06-26 — Phase 5 closed)
- **Date:** 2026-06-23 (5.4 build + closure) → 2026-06-26 (5.5 live routing eval + Phase 5 docs closure)
- **Phase:** 5.4 — QA-pipeline wiring (`QaFacadeService`, shared cross-cutting guards, context-aware output validation); 5.5 — routing-accuracy evaluation
- **Related:** ADR 0020 (5.3 — `ToolRouterService`, the routing mechanics this wires in), ADR 0007 (the QA chain / `ask()` direct path), ADR 0013 (output-validation / prompt-security this parameterizes), ADR 0016 (the `qa:v1:*` answer cache — direct-path only), ADR 0011 (SSE streaming — stays direct), ADR 0017 (the eval harness this extends)

---

## Context

ADR 0020 delivered `ToolRouterService.route()` in isolation — single-shot routing
(`search_content` / `query_metadata` / both / none), tested with a mocked LLM but
**not wired into the QA pipeline**. 5.4 makes routing a live, toggle-selected path
of `POST /api/v1/questions` without disturbing the Phase-4 direct RAG path, and 5.5
measures whether the model actually routes correctly.

Two integration problems had to be solved without regressing Phase 4:

1. **Two answer-producing paths, one endpoint.** The classic direct path (`ask()`:
   retrieve → ground → generate) and the new tool-use path must share the
   cross-cutting guards (ingestion-lock, data-integrity, input-sanitization,
   output-validation) without duplicating them and without double-processing.
2. **Output validation assumes `[Source N]` citations.** The Phase-1.6 validator
   (ADR 0013) hard-requires a `[Source N]` marker. A `query_metadata` answer
   ("There are 319 episodes.") legitimately has no chunk citation — under the old
   validator it would 500. Relaxing the rule globally would let the direct path
   emit uncited answers, eroding the grounding guarantee.

## Decision

### 1. `QaFacadeService` (Option C3) — the controller talks only to the facade

`QaController` calls a single `QaFacadeService`, which selects the path behind
`TOOL_USE_ENABLED` (default **false**): `false` → `QaChainService.ask()` (byte-identical
Phase 4); `true` → `ToolRouterService.route()`. **Why a facade and not a branch in the
controller or in `QaChainService`:** the controller stays a thin pass-through (the
1.7 contract), `QaChainService` keeps its single responsibility (the direct chain),
and the path choice lives in exactly one seam. `QaModule` imports `ToolsModule`
(not the reverse) so the graph stays **acyclic** — the Phase-4 path never depends on
the tool layer.

### 2. Shared cross-cutting guards — one implementation each, no double-processing

The guards both paths need were extracted to a single implementation each:
sanitization and output-validation were already services; the integrity-check and
ingestion-lock became `assertDataIntegrity()` / `assertIngestionNotInProgress()`
read-only seams on `QaChainService` (state and ownership unchanged). The facade's
tool-use branch runs them in the **same order as `ask()`**: lock → integrity →
sanitize → route → output-validation. **Why seams on `QaChainService` rather than a
new shared service:** the checks already lived there with their state; exposing them
as read-only methods avoids moving ownership for no benefit. **Why the direct path's
guards stay inside `ask()`:** the facade does not re-wrap the direct path — only the
tool-use branch composes the shared guards — so there is no double-processing.

### 3. Context-aware output validation — `validate(answer, corr, kind: AnswerKind)`

The validator is parameterized by an explicit `AnswerKind` enum:
- `DIRECT` keeps the strict `[Source N]` citation requirement (the Phase-4 grounding
  guarantee is unchanged).
- tool-use kinds **relax** the citation requirement (a metadata answer has no chunk
  to cite).
- a **universal fail-loud floor** (reject empty answers and prompt/system leakage)
  applies on **every** kind.

**Why an explicit enum and not inference:** the policy must be decided by the caller's
known context, never guessed from the answer text (a magic-string sniff would be
fragile and could silently mis-classify). The universal floor guarantees relaxation
never becomes a hole — it removes the citation rule, not the safety checks — so the
fix for metadata-answer 500s does **not** swallow real failures (empty / leaked
output still 500 on the tool path too).

### 4. Unified `AnswerResponseDto` — additive superset

One response shape serves both paths: `answer` + `sources` always present (so
existing clients are unaffected), plus additive `toolUsed?` / `latency?` (tool-use
only) and `path` (always present, `'direct' | 'tool_use'`). `sources` is `[]` on the
tool-use path (the router consumes tool results internally and surfaces no chunk
citations). **Why a superset and not a second DTO:** callers get a stable contract and
can branch on `path`; the eval harness reads `toolUsed` / `path` directly.

### 5. Routing-accuracy evaluation (5.5) — a separate, deterministic runner

Routing accuracy is scored by a **dedicated** harness (`evaluation/run_routing_eval.py`
+ `tool-routing-dataset.json`, 33 labeled questions across 7 categories), distinct
from the Phase-4 Ragas runner. It scores three **independent** dimensions — routing
(set-based, order-free; `scope_honesty` routing is tolerant of `[]` or
`[query_metadata]`), deterministic value checks, and honesty — and writes
`routing-eval.md` + `.json`. **No Ragas / faithfulness / recall here:** the tool-use
path reuses the Phase-4 retrieval engine whose generation quality was already
measured (ADR 0019); re-measuring it would be redundant. A **fail-loud tool-use-path
guard** probes one known tool-use question and asserts `path == 'tool_use'` before
scoring — because `TOOL_USE_ENABLED` is snapshotted at API startup
(`ConfigModule cache:true`), a direct-mode API would otherwise score as 33 misroutes.

## Consequences

- **Live eval result (2026-06-26, real Gemini, `evaluation/results/routing-2026-06-26/`):**
  **routing accuracy 97% (32/33)**; per-category **100% on 6 of 7** — content, count,
  filter, aggregate, parallel (every parallel question correctly fired both tools),
  no_tool (greetings → no tool); **scope_honesty 4/5** (the one miss, r029, routed an
  out-of-scope "affiliation" question to `search_content`). 557 Jest tests pass after
  5.4, 0 regressions, Phase 4 behavior byte-identical.
- **Known limitations** (full list a–f in CLAUDE.md "Phase 5 — closure"): router
  resilience deferred (required before prod `TOOL_USE_ENABLED`); the r029 scope-leak
  is accepted (candidate prompt tweak); the honesty score (0/4) is a **measurement
  artifact** of reusing Phase-4 refusal patterns on tool-use-style refusals (≈3/4 in
  reality); r001/r022/r033 are pre-existing retrieval/generation gaps, not routing
  faults; the `qa-facade.integration.spec` env-snapshot test-harness limitation; and
  the by-design omissions (no tool-use response cache, no streaming tool-use).

## Alternatives rejected

- **Branch on the toggle in the controller or `QaChainService`:** spreads the path
  decision across layers and bloats the thin controller / single-responsibility chain.
  The facade keeps it in one seam.
- **`ToolsModule` importing `QaModule`:** would cycle. `QaModule → ToolsModule`
  (acyclic) keeps the Phase-4 path independent of the tool layer.
- **Globally relaxing the `[Source N]` requirement:** would let the direct path emit
  uncited answers, breaking the Phase-4 grounding guarantee. The `AnswerKind` enum
  scopes relaxation to the tool path only.
- **Inferring the validation policy from the answer text:** a magic-string sniff is
  fragile and can mis-classify; an explicit caller-supplied `AnswerKind` is the safe
  source of truth.
- **Reusing the Phase-4 Ragas runner for routing:** wrong instrument — routing is a
  discrete tool-selection question, not a generation-quality one, and re-running Ragas
  would re-measure the already-measured retrieval engine. A separate deterministic
  routing scorer is cheaper and directly answers "did it route correctly?".
- **Scoring routing without the tool-use-path guard:** a direct-mode API (flag not set
  at boot) would silently produce 33 misroutes; the probe converts that into an
  explicit, actionable failure.
