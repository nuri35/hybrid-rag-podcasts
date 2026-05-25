# ADR 0012 — LLM token usage tracking via callback handler

- **Status:** Accepted
- **Date:** 2026-05-25
- **Phase:** 1.6 Sprint Token (3 steps + docs)
- **Related:** ADR 0010 (Sprint Retry — same composer wrap that the callback attaches inside), ADR 0011 (Sprint Streaming — `streamChain` carries the callback through to `chain.stream`), ADR 0007 (Phase 1.6 QaChainService — the consumer of the captured counts)

---

## Context

The chat LLM call is the dominant cost of a RAG query: Gemini bills per-million tokens for both input and output. Phase 1.6 ships a working pipeline but has no visibility into per-request token consumption. We log latency, source count, score telemetry — but not whether a query that took 3 seconds burned 1,500 tokens or 15,000.

This blocks four downstream concerns:

1. **Cost projection.** "How many requests per day before we exceed the free tier?" requires per-request token data.
2. **Prompt-quality regression.** Phase 2 evaluation will tweak the prompt template; we need a token-count baseline to detect whether changes accidentally inflate prompt size.
3. **Operator triage.** When a request fails with `RetryExhaustedException`, knowing whether it burned 14,000 tokens before failing vs ~100 changes the diagnosis (chunk-bloat vs early failure).
4. **Future `/metrics` endpoint.** Phase 1.7.5 observability needs cumulative counters to expose; this sprint plants the data plane.

The capture surface is non-obvious. LangChain provides three potential hook points (callbacks, output parsers, AsyncLocalStorage), and the storage shape ranges from "per-request injection" to "global counter". Each combination has different ergonomic and correctness trade-offs — we needed explicit decisions before writing the code.

## Decision

### 1. LangChain callback handler, not output parser or AsyncLocalStorage

`BaseCallbackHandler` with a `handleLLMEnd` method attached via the LangChain `{ callbacks: [...] }` invocation option. The handler runs after the LLM returns and inspects the `LLMResult` for `usage_metadata`.

Why this surface:

- **Non-invasive.** The chain composition (`promptTemplate | llm | StringOutputParser`) is unchanged. The handler attaches per-call at the invoke/stream site, not by wrapping the chain itself. Sprint Retry's `ResilientLlmService` composer is the natural attach point.
- **Idiomatic for the framework.** LangChain explicitly exposes the callback surface for observability concerns. Recruiters reading the code will recognise the pattern; we don't have to invent project-local infrastructure.
- **Streaming and non-streaming share the mechanism.** The handler fires on `handleLLMEnd` regardless of whether the model was invoked with `.invoke()` or `.stream()`. Same code path for both QA endpoints.

Considered alternatives:

- **Custom output parser** that reads usage and forwards the answer. Would couple capture to the parser layer; we already have `StringOutputParser` doing its job and a parser-wrapping approach would make swapping parsers harder.
- **AsyncLocalStorage** via Node's async-context-aware storage. Would let us avoid passing `correlationId` through call sites, but introduces a runtime concern (every async boundary needs to preserve context) and an additional abstraction that future maintainers have to know about. The explicit-param approach is more honest about the data flow.
- **Wrap `ChatGoogleGenerativeAI.invoke` directly.** Would tie us to a specific provider class. Callback handler works against the abstract `Runnable` interface.

### 2. Correlation-ID-keyed in-memory map with 60 s TTL

`Map<string, { usage: TokenUsage; expiresAt: number }>` indexed by correlation ID. `consumeUsage(id)` retrieves AND removes the entry; `pruneExpired()` runs lazily on every access to drop anything older than 60 seconds.

Why this storage:

- **Per-call scope without a database.** Token counts live at most ~5 seconds from capture to log line — keeping them in process memory is the right time scale.
- **Correlation ID is already the natural key.** Phase 1.5/1.6 hardening lifted correlation IDs to per-request identity. Reusing that ID for token capture lets the log line tie capture and emit together, which is exactly what the operator wants to see.
- **60 s TTL is the safety net, not the primary mechanism.** Successful requests consume their entry immediately. The TTL only matters if the consumer (QaChainService) never calls `consumeUsage` — e.g., the LLM call failed before its catch ladder reached the usage-read. Without a TTL, those orphan entries would accumulate forever.

Considered alternatives:

- **Pass the captured `TokenUsage` back from `ResilientLlmService` as a return value.** Would tighten coupling — `invokeChain<T>` would have to return `{ result: T, usage: TokenUsage }`, polluting every call site that doesn't care about usage. The map-based approach keeps `invokeChain`'s return shape clean.
- **Redis-backed storage.** Sprint A's Redis is already running, but per-request token data doesn't need cross-process coordination — every QA call runs in a single process and consumes the capture milliseconds later. Adding Redis here would buy nothing and add a network round-trip.
- **Singleton global slot** (latest call's usage stored on a single field). Loses concurrency safety — two requests in flight would race the slot.

### 3. Dual extraction path — `llmOutput.tokenUsage` first, `usage_metadata` fallback

```ts
// Path 1: OpenAI-style normalisation (older LangChain.js)
output.llmOutput?.tokenUsage → { promptTokens, completionTokens, totalTokens }

// Path 2: provider-raw form (newer @langchain/google-genai, Anthropic)
output.generations?.[0]?.[0]?.message?.usage_metadata → { input_tokens, output_tokens, total_tokens }
```

Why two paths:

- **LangChain's surface varies by version + provider.** `@langchain/google-genai` 0.2.x produces the second shape; older OpenAI integrations produced the first; some Anthropic versions produce the first, etc. Pinning to one shape would break when LangChain ships a minor version bump.
- **Both paths use loose `unknown`-narrowed typing.** We can extend with a third path without changing the public API. If a future LangChain version moves usage to yet another field, the change is one extra `if` block.
- **Field-name normalisation happens at extract time.** Internal type is `TokenUsage { inputTokens, outputTokens, totalTokens }` (camelCase) — independent of which path provided the data.

### 4. "Unknown" fallback rather than failing the request on missing metadata

When `extractUsage` returns null (neither path carries data) the captured slot stays empty. `consumeUsage` returns null. `formatTokenFields(null)` returns ` input_tokens=unknown output_tokens=unknown total_tokens=unknown`. The request returns the answer/stream normally.

Why fail-open:

- **Telemetry must NEVER break the user flow.** This is the core principle: a missing diagnostic field is an operator concern, not a user-facing concern. The user gets their answer; the operator sees the `unknown` marker and investigates the SDK change.
- **Distinguishable signal.** "0/0/0" would be ambiguous (legitimate zero output? capture failure?). "unknown" is loud and unmistakable.
- **The warn log line is the trigger.** `token_usage_missing correlation_id=… reason=no_metadata_in_response` lets an alerting system page when usage capture starts failing without any user impact.

### 5. No response-body exposure — logs only

`QaResponseDto` and the SSE event stream do NOT carry token counts. They live exclusively in server-side log lines.

Why:

- **Audience mismatch.** The user-facing audience (the recruiter testing the curl endpoint, the frontend client rendering an answer) cares about answer quality, sources, citations. Token counts are operator diagnostics; they belong in operator-facing surfaces (logs, future `/metrics`).
- **Wire-format pollution.** Adding a `usage` field to `QaResponseDto` would require Swagger schema changes, DTO validation rules, client SDK updates, and become a thing clients depend on. Big cost for telemetry that nobody outside Ops asked for.
- **Easy to add later if needed.** Adding response-body exposure is a one-line `QaResponseDto.usage = …` change; removing it once shipped is breaking. We pick the additive direction.

### 6. Process-lifetime rolling totals exist NOW even though `/metrics` is deferred

`getRollingTotals()` exposes cumulative sums (`totalInputTokens`, `totalOutputTokens`, `totalRequests`) since process start, plus a `sinceTimestamp`. No HTTP endpoint surfaces them yet — Phase 1.7.5 will add `/metrics`.

Why now, not later:

- **Zero additional cost.** Two integer adds in `recordUsage`. No memory pressure, no GC churn.
- **The data plane needs to exist before the HTTP plane can read from it.** Phase 1.7.5 will be focused on Prometheus / OpenTelemetry instrumentation; having `getRollingTotals` already returning a typed shape means the metrics layer becomes a one-method-call adapter instead of a "first add a counter, then read it" refactor.
- **`sinceTimestamp` lets `/metrics` compute rates.** "RPM since service start" = `totalRequests / (now - sinceTimestamp)`. Without the timestamp, the totals are less actionable.

### 7. Same correlation ID across capture, ResilientLlmService, log line, and failure-wrap path

`QaChainService.ask()` generates the correlation ID at the top of the method (was previously in the catch wrap path only). It flows through:

- `ResilientLlmService.invokeChain(chain, input, correlationId)` → `tokenUsage.createCallback(correlationId)`
- Callback writes into `captures[correlationId]`
- Success path: `consumeUsage(correlationId)` → log line
- Failure wrap path: same ID surfaces in `QaChainFailedException`

Why single-ID-per-request:

- **Operator grep matches.** When on-call investigates a failed query, `grep correlation_id=… server.log` returns every line related to that single request, including the token-usage capture (when it succeeded before the failure).
- **Capture-and-emit guarantee.** Same generation site means we can't have a race where the callback writes under ID `X` but the log line reads under ID `Y`.
- **No new entropy.** `randomUUID()` from `node:crypto` was already being used by Phase 1.5/1.6 wrap paths — we just lifted the call to be the request's first action.

## Alternatives considered (and rejected)

- **LangSmith / hosted observability.** Production-quality solution, but requires an external account, network round-trips, and a dependency on a hosted service. Overkill for a portfolio project that needs to demonstrate the pattern, not the SaaS integration.
- **Direct OpenTelemetry instrumentation.** Better long-term solution. Deferred to Phase 1.7.5 (observability pack) because OTel setup is its own design surface (exporters, collectors, sampling rules). The callback-handler path is the right primitive regardless; OTel will read from the same `RollingTokenTotals` shape later.
- **Per-token streaming usage** (emit `usage` per chunk during `streamChain`). Gemini's SDK only provides `usage_metadata` in the final chunk, not progressively, so this isn't possible without inferring counts from text length (unreliable).
- **Sliding-window totals** (last 60 minutes of token counts, not lifetime). Adds bookkeeping complexity; Phase 1.7.5's `/metrics` endpoint can do the windowing externally via Prometheus `rate()`.

## Consequences

- Every `qa_complete` and `qa_stream_complete` log line now carries three additional fields. Log volume per line increases by ~50 bytes; negligible.
- A noisy upstream that changes its usage-metadata field path will surface as `input_tokens=unknown` log markers without breaking any request. Operator gets a clear signal to update `extractUsage`.
- Phase 2 evaluation can read tokens from logs to compute "cost-per-answer" against the golden Q-A dataset without changes to the test harness.
- Phase 1.7.5 `/metrics` endpoint becomes a thin GET handler over `tokenUsageService.getRollingTotals()` — no new business logic.
- Future "auth-aware per-user tracking" requires changes to the capture key (correlation-ID → user-ID-plus-correlation-ID) but the storage shape and `consumeUsage` semantics stay identical. The decision to use a map keyed by a string ID was deliberately forward-compatible.
- The `60 s TTL` is a tuned default. If we ever observe the captures map growing in production, the TTL is the first lever to adjust. Currently lazy-pruned on access; if needed, a background interval can be added without changing the public API.
