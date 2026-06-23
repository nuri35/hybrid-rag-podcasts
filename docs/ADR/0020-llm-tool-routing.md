# ADR 0020 — LLM tool routing: single-shot chain, AUTO tool-choice, binding-safe schemas

- **Status:** Accepted (Phase 5.3 complete, 2026-06-23)
- **Date:** 2026-06-22 (Step-0 research + bindTools verification) → 2026-06-23 (5.3.1–5.3.6 build + closure)
- **Phase:** 5.3 — Tool Routing (`bindTools` + `ToolRouterService`); sub-phases 5.3.1 factory → 5.3.2 router core → 5.3.3 system prompt → 5.3.4 parallel + count-all → 5.3.5 fallback + logging → 5.3.6 tests + closure
- **Related:** PHASE_5_1_PLAN.md (`MetadataQueryService` — the `query_metadata` engine), PHASE_5_2_PLAN.md (the two tool definitions + locked descriptions), ADR 0019 (hybrid retrieval — the `search_content` engine), ADR 0007 (the QA chain this is NOT yet wired into — that is 5.4)

---

## Context

Phase 5.2 produced two isolated, tested tool services — `search_content` (wraps
hybrid retrieval, returns passages) and `query_metadata` (wraps the episode-grained
aggregation engine, returns exact facts). 5.3 makes an LLM choose between them and
answer from the result. The scope boundary is **locked**: a single-shot chain — one
round of tool calls (single OR parallel), then a text answer. **Not agentic; no
serial re-planning loop.** Reuse the existing `LlmService` (Gemini via
`@langchain/google-genai`); do NOT wire into the QA pipeline (that is 5.4).

A live end-to-end check during Step-0 surfaced a hard constraint: binding the
**strict** Phase 5.2 Zod schemas to Gemini **400s** — `top_k`/`limit` use
`.int().positive()`, which emit JSON-Schema `exclusiveMinimum`, a keyword Gemini's
`FunctionDeclaration.parameters` (a restricted OpenAPI subset) rejects, and the
`@langchain/google-genai` converter does not strip.

## Decision

### 1. Single-shot two-call flow, final invoke UNBOUND (the core guarantee)

`route()` invokes the **tools-bound** model once; if it returns no `tool_calls`,
that message IS the answer (direct path). Otherwise we execute the tools, feed the
results back, and invoke the **UNBOUND** model (`createChatModel()`, no `bindTools`)
to produce the text answer. **Why unbound:** with no tools bound the model *cannot*
emit `tool_calls` again, so a second tool round — and therefore an agentic serial
loop — is **structurally impossible**, not merely discouraged by a prompt or a
counter. This is the cheapest possible enforcement of the locked scope.

### 2. AUTO tool-choice

Bind with the default `FunctionCallingMode.AUTO` — the model decides *whether* and
*which* tool(s) to call. **Why not forced:** chit-chat/greetings must be answerable
with no tool (the direct path), and parallel multi-tool must remain possible; forcing
`ANY` or a specific tool would break both. The routing boundary is steered by the
system prompt (decision 6), not by constraining tool-choice.

### 3. Flat binding-safe schemas, strict schemas stay strict

The model is bound to **separate** binding schemas where `top_k`/`limit` are plain
`z.number()` (no `.int()/.positive()`, no `exclusiveMinimum`) and `query` is a plain
`z.string()` (no `minLength`). The **strict** Phase 5.2 schemas are unchanged and
still run inside each tool service's `execute()`. **Why the split:** the binding
schema only has to be a vocabulary Gemini accepts; correctness (positive integers,
non-empty query, clamping) is the *service's* job at the trust boundary. Relaxing the
bound schema weakens nothing — it isolates the Gemini-compat concern to one layer and
keeps a single source of truth for validation. (Flat-object + enum discriminator over
a discriminated union was already locked in 5.2.2 for the same converter reason.)

### 4. Parallel execution, but still ONE round

If the model emits multiple `tool_calls`, all run via `Promise.allSettled` and each
yields exactly one `ToolMessage` (carrying its `tool_call_id`) before the single
final invoke. **Why `allSettled` not `all`:** one tool's failure must not discard
another tool's successful result — they are independent. **Why one ToolMessage per
call:** Gemini rejects the final invoke if any `tool_call` id lacks a matching
response. Single-shot ≠ single-tool: parallel breadth is allowed, serial depth is not.

### 5. Fail-loud / fail-open asymmetry in the fallback handler

`settledResultToToolMessage` routes each settled result **by exception type**:
- `InvalidToolInputException` (the model produced bad args) → a controlled-error
  `ToolMessage` (named constant), so the final invoke still answers honestly
  ("I don't have that information."). **Graceful** — a model mistake should not 500
  the request, and single-shot forbids a corrective retry loop.
- `MetadataQueryFailedException` / any other system error → **rethrow**; `route()`
  propagates and the final invoke never happens. **Fail-loud** — an exactness-critical
  infra failure (5.1's contract) must never be silently dressed up as a tool result the
  model could hallucinate around. The default for *unknown* errors is propagate, the
  conservative choice. This mirrors the QA layer's existing fail-loud-on-infra posture.

### 6. Routing system prompt frames (does not duplicate) the locked descriptions

A single `ROUTER_SYSTEM_PROMPT` constant is message[0] on both invokes. It sharpens
the content-vs-exact-fact boundary, adds a **number/ranking tie-breaker → query_metadata**,
the **count-all → leave field/value empty** instruction, ground-only-in-tool-results +
refuse-don't-fabricate, a **metadata scope-honesty** bound (only episode count / guests /
titles / duration), and `[Source N]` citation. Refusal is **English-only** — a bilingual
instruction risks language-switching on the English dataset. **Why a prompt and not
more code:** the tool *descriptions* are the contract; the system prompt is the routing
hinge that tunes selection without changing mechanics.

### 7. Count-all tolerance lives in the adapter, not the service

The model sometimes attaches a `field` to a whole-collection `count` with no `value`.
`QueryMetadataToolService.applyCountAllTolerance()` drops that orphan `field` BEFORE
the strict parse → maps to count-all instead of 400-ing. **Why the adapter, scoped to
`count`:** the strict `queryMetadataInputSchema` and `MetadataQueryService` contract
stay pure (a direct `safeParse` of the same shape still rejects it — proven by test);
the tolerance is a narrow, well-named input normalization, not a general loosening.

### 8. Placement: `ToolRouterService` in `src/modules/tools/`, dispatch by a name→tool map

The router lives in the existing `ToolsModule` (imports `LlmModule`; injects both tool
services). A `Map<toolName, tool>` keyed by the locked name constants resolves a
`tool_call` name to its tool — no scattered `if`s, no magic strings, and a third tool
later is one map entry. **Why not `QaModule`:** importing it would cycle once 5.4 wires
routing back into the QA pipeline; the Phase 4 path stays untouched.

## Consequences

- `route()` returns `{ answer, toolUsed: string[], latency }` — rich enough for the
  5.3.5 per-tool logging and the 5.5 routing-accuracy eval; `toolUsed` is an array so
  the parallel case needed no shape change.
- No retry/circuit/timeout around the routing invokes — deferred to **5.4** (pipeline
  integration), where the existing `ResilientLlmService` composition applies.
- **Routing accuracy is NOT measured here** — that is **5.5**. 5.3 asserts mechanics
  (dispatch, single-shot, parallel shape, fallback asymmetry, logging) via a mocked
  LLM, plus a skippable real-Gemini sanity suite.

## Alternatives rejected

- **Agentic / serial tool loop** (LangGraph-style re-planning until done): out of the
  locked scope; single-shot is sufficient for the four query types and far cheaper to
  reason about. The unbound final invoke enforces it structurally.
- **Binding the strict schemas directly:** 400s on `exclusiveMinimum` (verified live).
- **One discriminated-union tool schema:** Gemini's function schema is an
  object-with-properties subset; unions convert unreliably (5.2.2 finding).
- **`Promise.all` for parallel tools:** one rejection would reject the whole round and
  lose sibling successes; `allSettled` + per-result type routing preserves them.
- **Converting infra failures to a ToolMessage** (uniform "graceful"): would let the
  model hallucinate around an exactness failure — violates 5.1's fail-loud contract.
- **Loosening the strict `query_metadata` schema** for the count-all case: would erode
  the trust boundary; an adapter-layer normalization keeps the service strict.
