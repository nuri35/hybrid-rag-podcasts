# ADR 0011 — SSE streaming endpoint with initiation-only resilience

- **Status:** Accepted
- **Date:** 2026-05-25
- **Phase:** 1.6 Sprint Streaming (3 of 3)
- **Related:** ADR 0007 (Phase 1.6 QaChainService — the layer this ADR extends), ADR 0010 (Sprint Retry resilience patterns — split here into initiation-only protection), ADR 0008 (HTTP endpoint design — second endpoint follows the same versioning and validation conventions)

---

## Context

Phase 1.6 shipped `POST /api/v1/questions` as a blocking request-response. A first-token-to-paint latency of 2–4 seconds is acceptable for short answers but feels sluggish for longer ones — by token 50, the user has been staring at a spinner for half a multi-paragraph response that the LLM has already partly generated. Token-by-token streaming is the standard solution and Gemini's SDK supports it.

Streaming introduces three design questions that needed explicit decisions:

1. **Endpoint topology.** A flag on the existing endpoint (`stream: true`), a separate endpoint, or a different protocol entirely (WebSocket, gRPC).

2. **Resilience semantics.** Sprint Retry's circuit breaker + retry policy were designed for atomic request-response calls. A stream has two phases (start vs continue) with different failure semantics; the existing primitives don't compose cleanly without an explicit decision about which phase they protect.

3. **Wire format edge cases.** SSE is simple in principle (lines of `data: <text>\n\n`) but has subtleties around heartbeats, error events, and ordering that matter for a portfolio API that recruiters might inspect with `curl`.

## Decision

### 1. Separate endpoint `/api/v1/questions/stream`, not a flag

The existing `POST /api/v1/questions` stays unchanged. The new `POST /api/v1/questions/stream` is a second route under the same controller, same path prefix, same DTO.

Why separate, not a flag:

- **Different response contracts.** `/questions` returns `application/json` with a `QaResponseDto` body. `/questions/stream` returns `text/event-stream` with a sequence of `MessageEvent`s. A single endpoint would have to switch its `Content-Type` and response shape based on input — confusing to document, confusing to consume, breaks OpenAPI typing.
- **Different SLA semantics.** The non-streaming endpoint has a clear total-duration timeout (`LLM_TIMEOUT_MS` wraps the whole `chain.invoke`). The streaming endpoint has an initiation timeout only — once tokens are flowing, the duration is unbounded. Encoding two SLA semantics into one endpoint hides the contract from the client.
- **Swagger / OpenAPI rendering.** A flag-based design produces ambiguous schema docs (the response body changes shape based on a request field). Two endpoints produce two clean entries in `/api/docs`.
- **No additional engineering cost.** Both endpoints share the lock guard, integrity check, retrieval, prompt template, and resilience layer. Only the LLM invocation differs (`chain.stream` vs `chain.invoke`). The duplication is tiny; the clarity payoff is large.

### 2. SSE, not WebSocket or long-polling

SSE was chosen because:

- **Unidirectional fits the use case.** Server → client only. No client → server channel needed during a single answer; the client just consumes the stream. WebSocket's full-duplex capability is wasted overhead.
- **HTTP semantics for free.** Status codes, auth headers, CORS, proxies, retries — all work the same as any other HTTP endpoint. WebSocket needs custom handling at each layer.
- **NestJS support.** `@Sse()` decorator turns an `Observable<MessageEvent>` into a properly-formatted SSE response with one line of code. WebSocket support exists (`@WebSocketGateway`) but requires a separate gateway, separate auth wiring, separate Swagger story.
- **No browser polyfill needed.** Native `EventSource` API is broadly supported.
- **Easy to demonstrate.** `curl -N -X POST -d '...' /api/v1/questions/stream` shows the event stream in a terminal. A recruiter clicking through the repo can see streaming work without spinning up a JavaScript client.

Long-polling was rejected outright — same response-completion latency as the non-streaming endpoint plus per-poll connection overhead, with none of the visual feedback benefit.

### 3. Circuit breaker + retry protect ONLY the initiation, not the consumption

`ResilientLlmService.streamChain` splits `chain.stream(input)` into two phases:

- **Phase 1 — INITIATION.** `chain.stream()` returns a `Promise<IterableReadableStream<O>>`. The promise's resolution requires the upstream to acknowledge the request (auth check, model lookup, payload validation). Failures here behave exactly like `chain.invoke` failures — transient blips deserve a retry, sustained failures should trip the circuit. Wrapped with circuit (outer) + retry (inner), same composition as `invokeChain`.

- **Phase 2 — CONSUMPTION.** `for await` over the resolved iterable yields tokens. Failures here propagate to the caller verbatim, no retry, no circuit signal.

Why phase 2 is unprotected:

- **Retry cannot replay a partial stream.** The client has already received N tokens. Re-running `chain.stream(input)` would re-emit those N tokens (or different ones — Gemini sampling is stochastic at non-zero temperature). Either case is worse than just surfacing the truncated stream as an error.
- **Stream-start implies upstream health.** If the upstream was sick at request time, the initiation Promise would have rejected. By the time tokens are flowing, the upstream has accepted the request and is generating content. A subsequent failure (network blip mid-stream, upstream OOM at token 600) is qualitatively different from a "service unavailable" signal — it does not predict whether the next request will succeed.
- **One circuit-level failure per request, not per token.** When a stream fails mid-flight, that failure should NOT count five times because five tokens streamed first. The circuit's "5 failures in 60 seconds → trip" semantics assume one failure signal per request; mid-stream failures violate that and would over-aggressively trip during a single flaky session.

The trade-off: a Gemini server that closes the stream mid-flight surfaces to the client as a partial answer plus an SSE `error` event. The client sees N tokens and then a clean error signal. This is the correct user experience for a flaky-network case; the alternative (silently retry, double-emit tokens) is worse.

### 4. `sources` event comes FIRST, before any `token` event

The contract: the very first event a client receives is the `sources` event (possibly empty), followed by zero or more `token` events, followed by exactly one terminator. Clients can confidently render citation UI as soon as they parse the first event, in parallel with token streaming.

Rejected alternatives:

- **`sources` event at the end** (after `done`). Makes UI rendering harder — clients have to render an answer, then re-render with citation references retroactively. The hop-on-the-fly UI experience that streaming exists to provide is undermined.
- **`sources` field on every `token` event.** Wasteful — sources are a one-time payload, not per-token state.
- **No `sources` event, infer from token content.** Would require the LLM to emit citation markers in its output and the client to parse them. Brittle.

### 5. Heartbeat is typed JSON, not an SSE comment line

The HTTP spec recommends `:heartbeat\n\n` (comment lines starting with `:`) for keep-alives. We chose `{"type":"heartbeat"}` JSON instead because:

- **Some browsers / EventSource polyfills don't surface comment lines reliably.** A typed JSON event is uniformly visible to `event.data` listeners.
- **Proxies sometimes strip whitespace-heavy short lines.** A normal `data: ...` line is harder to filter accidentally.
- **Client-side handling is simpler.** One JSON.parse path for everything; clients just `switch (event.type)` and have a `case 'heartbeat': /* no-op */`.
- **Cost is trivial.** ~30 bytes per heartbeat every 15 s.

Documented in the endpoint's Swagger response so consumers know to ignore the `heartbeat` type.

### 6. Timeout applies ONLY to phase-1 initiation

`LLM_TIMEOUT_MS` (default 30 s, configurable in env) wraps the call from "`chain.stream(input)` invoked" until "first chunk arrived." Once a token has been emitted, the timeout is released and the rest of the stream can take as long as it needs.

Why:

- **Total duration is legitimate variance, not a failure signal.** A short factoid answer might complete in 2 seconds; an essay-style multi-paragraph answer might run 60 seconds. Both are healthy.
- **Initiation latency IS a meaningful signal.** A `chain.stream()` call that hangs for 30 s without yielding anything is almost certainly stuck on the upstream's request-routing layer, not on generation. Failing fast is correct.
- **The non-streaming endpoint's total-duration timeout would defeat the whole point of streaming.** A 60-second essay would just timeout and look like a generic failure to the user, even though the first 50 tokens shipped fine.

Implementation: `invokeStreamWithTimeout` races `source.next()` against a `setTimeout`-backed promise for the first chunk only. After the first chunk yields, the timeout handle is cleared and subsequent iterations have no timeout.

### 7. Mid-stream throw vs mid-stream yield-error

`askStream`'s catch block routes mid-stream errors two ways:

- **Known exceptions** (`CircuitOpenException`, `RetryExhaustedException`, the full validation/infra ladder from `ask()`) THROW out of the generator. The controller's `for await` re-throws into `subscriber.error`. NestJS attempts to map the HTTP status if it can still set headers. The wire-level outcome is "stream closes abruptly with whatever status NestJS could set" — clients must handle abrupt close.

- **Unknown exceptions** are caught and YIELDED as an SSE `error` event with a server-side correlation ID in the `message` field. The generator then returns normally. The client receives a clean wire-format error signal alongside the events it already got.

The asymmetry is intentional. Known exceptions have HTTP semantics that we want preserved (503 with `retryAfterSeconds`, validation 400s, etc.). Unknown exceptions don't have a useful HTTP status; surfacing them as data preserves the client's wire-format invariant and gives the operator a correlation ID to grep.

## Alternatives considered (and rejected)

- **WebSocket bidirectional channel.** Overkill for unidirectional streaming. Adds gateway scaffolding, auth duplication, Swagger gap. Rejected unless we ever need true bidirectional flows (e.g., user-interrupts-streaming, mid-stream clarification).
- **GraphQL subscriptions.** Same overkill argument plus the project doesn't have a GraphQL surface to begin with.
- **`chain.stream()` flag on the existing controller method.** Discussed in §1 — breaks the response-contract clarity that lets Swagger document both shapes cleanly.
- **NDJSON streaming over a regular response body.** Considered briefly. NDJSON has no native browser EventSource equivalent; clients would need a streaming JSON parser. SSE has `EventSource` on every major browser. The portfolio-API readability argument matters here.
- **Mid-stream retry with token-deduplication on the client.** Plausible but complex. Requires the server to assign token IDs and the client to keep a buffer. The current design (mid-stream errors close the stream cleanly) is simpler and adequate for the failure modes we actually see (network blips, upstream OOMs — both rare).
- **Resumable streams via `Last-Event-ID` header.** Would require the server to maintain a recent-token buffer per session. Significant state-management complexity for marginal benefit when the typical answer completes in <30 s.
- **`rxjs.merge(events$, heartbeat$)` for the controller.** Considered and rejected during implementation — `interval$` is unbounded, so the merged Observable never completes even after `events$` finishes. Switched to explicit `new Observable(subscriber => ...)` construction so heartbeat lifetime is tied to the subscription via `clearInterval` in `finally` + teardown.

## Consequences

- A user asking a long question now sees the answer materialize token-by-token within ~2 seconds of submitting, instead of waiting 10+ seconds for a complete response. The total time-to-final-token may even be slightly slower (the chunked transfer adds overhead), but perceived latency improves dramatically.
- Sprint Retry's protection still applies to the failure modes that matter — bad credentials, deprecated models, sustained 5xx storms — because those manifest at initiation. Mid-stream flakiness now surfaces as truncated answers with error signals, which is the honest representation.
- The controller's Observable construction is more verbose than `merge(...)` would have been, but the explicit lifecycle management is necessary correctness, not style.
- Future Phase 2 evaluation can drive `askStream` programmatically via the same DI-injectable `QaChainService`, collecting token timing data alongside answer text. No HTTP layer needed in the eval harness.
- Future Phase 4 (hybrid retrieval) inherits the streaming surface for free — when the hybrid retrieval lands, a `/api/v1/questions/stream/hybrid` endpoint can be added with the same composer pattern.
- New env knob ceiling: `LLM_TIMEOUT_MS` now has two interpretations depending on endpoint. Documented in the env-schema comment and the endpoint's Swagger description. Stays a single env var rather than splitting because the value is the same in both cases (we want fast-fail at 30 s on initiation regardless of streaming).
- The non-streaming endpoint's behaviour is unchanged. Existing curls, tests, and Swagger examples for `POST /api/v1/questions` all keep working.
