# ADR 0010 — LLM resilience via retry policy + circuit breaker

- **Status:** Accepted
- **Date:** 2026-05-24
- **Phase:** 1.6 Sprint Retry (Phases 1 / 2 / 3 of 3)
- **Related:** ADR 0007 (Phase 1.6 LlmModule + QaChainService — the layer this ADR wraps), CLAUDE.md decisions #2 (LCEL composition) and #16 (URI versioning + global ValidationPipe)

---

## Context

Phase 1.6 shipped `QaChainService.ask()` with a straight `chain.invoke()` to the Gemini chat model. The Phase 1.6 hardening pass added `LLM_TIMEOUT_MS` as a `Promise.race`-backed timeout so a hung call could not block a request indefinitely. Two production-grade gaps remained:

1. **Transient failures get no retry.** Every Gemini 429 / 502 / 503 / 504 / `ETIMEDOUT` propagates straight to the client as a 500 wrapped in `QaChainFailedException`. The natural recovery — "wait a moment and try again" — has to happen at the client. For a portfolio API a recruiter is clicking through, that's wasted engineering ground when retry is a well-understood pattern.

2. **Sustained failures keep hammering the upstream.** If Gemini is genuinely down for the next ten minutes, every incoming request still does the full `embed → retrieve → format → invoke` dance and burns API quota / latency before the inevitable failure surfaces. A circuit breaker fast-fails the request *and* spares the upstream while it recovers.

The two patterns address opposite ends of the same axis (single transient blip vs sustained outage), and they compose cleanly — but the composition order is non-obvious and the in-memory / Redis trade-off needed an explicit decision.

## Decision

### 1. Both patterns, not one

The transient-vs-sustained distinction is real, and neither pattern subsumes the other. Retry alone would still hammer a dead upstream `maxAttempts × failureThreshold` times per request once the backend stays down. Circuit breaker alone would surface every 429 to the client even when a single backoff-and-retry would have succeeded silently.

Together they cover the full failure distribution:

- One-off 429 → retry succeeds on attempt 2 or 3, client sees a normal 200.
- Sustained 503 (Gemini outage) → first request triggers `maxAttempts` retries, hits `RetryExhaustedException`, counts as one circuit-level failure. After `failureThreshold` such cycles, the circuit OPENs and subsequent requests fail in <1ms with `CircuitOpenException` (503 with `retryAfterSeconds`).
- Recovery → after `openDurationMs` cool-down, the next request becomes a single HALF_OPEN probe. Success closes the circuit; failure re-OPENs it for another cool-down cycle.

### 2. Circuit breaker is outer, retry is inner

The composition stack from outer to inner:

```
QaChainService.invokeWithTimeout          ← Phase 1.6 hardening (outermost)
  └── CircuitBreakerService.execute       ← outer
        └── RetryPolicyService.execute    ← inner
              └── chain.invoke(input)     ← innermost
```

Why this order:

- **Circuit MUST be outer.** If retry wrapped circuit, an OPEN circuit would still let retry hammer it `maxAttempts` times per request before noticing the circuit was open. That defeats the whole point of having a circuit. With circuit outer, an OPEN circuit short-circuits immediately and retry never runs.
- **Retry is inner.** A full retry cycle (success-after-N OR exhaustion) is one "attempt" from the circuit's perspective. The circuit's failure counter increments once per request that ultimately failed, regardless of how many retry attempts went into that decision. This is the semantic the failure threshold is intuitive for: "5 failed requests in 60 seconds → trip" matches operator mental model, not "15 wire-level failures".
- **Timeout stays outermost.** The Phase 1.6 hardening `LLM_TIMEOUT_MS` race is unchanged — a hung resilience layer (e.g. a misbehaving retry sleep, a hot-loop bug) still can't block the request indefinitely.

### 3. In-memory circuit state, not Redis

The circuit breaker keeps its `state` + `failureTimestamps[]` + `openedAt` as private fields on the service instance. State does not federate across replicas. Each pod / worker accumulates its own failure window and makes independent OPEN/CLOSED decisions.

Considered alternative: store circuit state in Redis (the Sprint A `ingestion:in_progress` infrastructure already exists, we could add `circuit:llm:state`). Rejected because:

- **Single-process portfolio deployment.** We have one process. Cross-replica coordination buys nothing for a one-process app. Adding a Redis round-trip on every `execute` call would add latency on every request for zero benefit.
- **Distributed circuit semantics are subtle.** With N replicas, do we want one shared circuit (any pod's failure trips it for everyone) or per-pod local circuits (each pod observes its own slice)? The "right" answer depends on whether failures are correlated across pods (shared upstream) or independent (per-pod outbound network). Pre-deciding this without evidence would be the wrong kind of premature design.
- **Local circuits are correct for our case.** Gemini is the shared upstream; if it's down, all pods will independently observe failures and trip their local circuits within a few requests of each other. The few extra failed-then-rejected requests during the convergence window are cheap.

When (if) the deployment scales beyond one pod and we see specific evidence that cross-pod federation helps, a Redis-backed variant can be layered on. Phase 1.7.5 Sprint A already proved the Redis infrastructure works for distributed coordination.

### 4. Single global counter, not per-error-type

The plan considered separate counters for 429 vs 503 vs network errors. Rejected because:

- **Operator mental model.** "5 failures in 60 seconds → trip" is intuitive. "5 of-type-429 or 3 of-type-503 or 2 of-type-network-error" is not.
- **Failure modes we actually see.** Gemini's 429 (rate limit) and 5xx (overload) are different surface symptoms of the same root cause (we're hitting the upstream too hard or the upstream is unhealthy). Splitting them by error code doesn't add diagnostic value; the underlying decision is the same: stop calling for a bit.
- **Single counter keeps the math simple.** The rolling window is easy to reason about and easy to tune.

Per-error-class telemetry is a Phase 1.7.5 Sprint C concern — observability hooks should expose the failure mix without splitting the trip decision.

### 5. Only chat LLM wrapped, not embedder

`RetryPolicyService` and `CircuitBreakerService` apply only to chat-LLM calls (via `ResilientLlmService.invokeChain`). The embedder is intentionally untouched.

- **Embedder already has its own retry.** Phase 1.3 implemented a two-layer token-bucket + adaptive-retry for Gemini embedding calls. It's tuned for the embedding-specific quirks (silent empty-array substitution in `@langchain/google-genai 0.2.x`, the 60-second Tier-1 reset window). Unifying it with the chat path would mean refactoring battle-tested ingestion code for no benefit.
- **Different SLAs.** Embedding runs once at ingestion (53 K vectors, ~50 min on Tier 1, batch-tolerant). Chat runs per-request (sub-second SLA). They have different acceptable failure-recovery latencies; a one-size-fits-all policy would compromise both.
- **Different scopes of impact.** Embedder failures during ingestion are not user-facing (CLI exits non-zero, operator re-runs); chat failures are user-facing 500s. Their resilience strategies *should* differ.

### 6. Retryable classification is deterministic and synchronous

`RetryPolicyService.isRetryable(error)` is a pure function — no I/O, no async, no external lookup. Classification rules in priority order:

1. **Node network code** (`error.code` matches `RETRYABLE_NODE_ERROR_CODES`) — `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`. Always retryable.
2. **HTTP status** extracted from `.status` / `.statusCode` / `.response.status` — only retry on `429`, `500`, `502`, `503`, `504`. Everything else (including all other 4xx) fails fast.
3. **Message-pattern fallback** when neither structured signal is present — `/rate.?limit/i`, `/timeout/i`, `/temporarily unavailable/i`, `/connection.*reset/i`. Covers SDKs that wrap errors without preserving status.

The third rule exists because LangChain wrappers occasionally produce plain `Error` objects whose message is the only diagnostic signal. Without it we'd be over-aggressive about non-retryability.

### 7. `RetryExhaustedException` and `CircuitOpenException` pass through QaChainService unwrapped

Both new exceptions are added to `QaChainService.ask()`'s pass-through ladder alongside the Phase 1.7.5 Sprint A exceptions. They are not wrapped in `QaChainFailedException` because:

- **`CircuitOpenException`** carries `retryAfterSeconds` in the response body — the client can decide whether to back off and retry or surface the unavailability to the user. Wrapping it as `QaChainFailedException` would flatten the hint into a generic 500 message.
- **`RetryExhaustedException`** carries `attempts` + `totalDurationMs` + `lastError`. The diagnostic detail is what makes the exception useful for on-call. Wrapping it would lose that.

The catch ladder routes via `instanceof` (not `error.name === 'X'`) so minification cannot break the routing.

## Alternatives considered (and rejected)

- **Use a library — `cockatiel`, `opossum`.** Both would work. Rejected because the two patterns are <200 LOC each, the project's portfolio-artifact goal is better served by hand-written code that demonstrates understanding, and adding a dependency for "we could read the source ourselves" felt like cargo-cult.
- **Make retry outer, circuit inner.** See §2 — defeats the circuit's whole purpose.
- **Retry on the LangChain Runnable side** (`.withRetry()` from `@langchain/core/runnables`). LangChain's retry exists but is opinionated about what's retryable, has no jitter, and shares no state with our circuit. Hand-rolled gives explicit retryable classification + jitter + statefulness in one place.
- **Per-call options to override retry settings.** `RetryPolicyService.execute` accepts a `Partial<RetryOptions>` second argument for future flexibility, but `ResilientLlmService.invokeChain` doesn't surface it today — every chat call uses the same defaults. When per-call tuning becomes useful (e.g. Phase 2 evaluation harness wanting deterministic single-attempt runs), the surface area is already there.
- **Surface `getSnapshot()` via the health endpoint.** Considered but deferred — adds a runtime dependency from `HealthService` onto `CircuitBreakerService` for what is fundamentally an observability concern. Phase 1.7.5 Sprint C will add proper metrics; bolting circuit state onto `/health` would crowd that endpoint with operator-facing detail.

## Consequences

- A Gemini 429 burst that previously surfaced as 500s now surfaces as 200s after one or two transparent retries, with `retry_attempt ...` warning logs for visibility.
- A sustained Gemini outage that previously burned `embed + retrieve + invoke` cost on every request now fails in <1ms with a 503 carrying `retryAfterSeconds` after 5 failures within 60 seconds.
- The composition is unit-testable in isolation (`RetryPolicyService` spec, `CircuitBreakerService` spec) and at the integration level (`ResilientLlmService` spec mocks both underlying services; `QaChainService` spec mocks `ResilientLlmService`). Test pyramid stays clean.
- Future Phase 4 (hybrid retrieval) and Phase 5 (query routing) inherit the resilience for free — they call `QaChainService.ask()` which already routes through the wrap.
- New env knobs (`LLM_RETRY_*`, `LLM_CIRCUIT_*`) give operators ways to tune defaults per-environment without code changes. Tier 2 / Tier 3 Gemini deployments can shorten the cool-down because outages are rarer; Tier 1 stays conservative.
- The strict single-flight HALF_OPEN probe prevents "thundering probe herd" recovery anti-pattern — when the circuit opens during a load spike, only one request gets to test the upstream at a time during cool-down expiry.
