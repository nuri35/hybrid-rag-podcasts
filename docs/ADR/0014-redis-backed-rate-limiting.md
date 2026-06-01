# ADR 0014 — Redis-backed per-IP rate limiting

- **Status:** Accepted
- **Date:** 2026-06-01
- **Phase:** 1.7 Sprint Rate-Limit (2 steps + docs)
- **Related:** ADR 0008 (Phase 1.7 HTTP endpoint — the surface now throttled), Phase 1.7.5 Sprint A (the `RedisService` + fail-open philosophy this storage reuses), ADR 0011 (Sprint Streaming — the SSE endpoint that gets the stricter limit), ADR 0010 (circuit breaker — the other 503-class defense in front of the LLM)
- **External reference:** `@nestjs/throttler` v6 (<https://github.com/nestjs/throttler>); OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption

---

## Context

The API exposes two LLM-backed endpoints (`POST /api/v1/questions`, `GET /api/v1/questions/stream`). Every request spends Gemini embedding + chat quota and Chroma retrieval time. With no rate limiting a single client — malicious or merely buggy — can exhaust the free-tier quota or pin the process, denying service to everyone else. This is OWASP API4 (Unrestricted Resource Consumption).

Two constraints shaped the design:

1. **Multi-instance correctness.** The service is meant to run as more than one replica behind a load balancer (Senaryo 9 from the sprint discussion). A naive in-memory counter per process means N replicas multiply the effective limit by N, and a client's requests landing on different replicas are counted independently — the limit becomes meaningless.
2. **Sprint A already provides Redis.** Phase 1.7.5 Sprint A added `RedisService` (an ioredis facade) and a fail-open coordination philosophy for the distributed ingestion lock. Rate-limit counters are the same kind of shared, ephemeral, cross-replica state, so they belong in the same Redis.

## Decision

### 1. `@nestjs/throttler` over a hand-rolled guard

Use the official NestJS rate-limiting package rather than writing a guard from scratch.

- It is mature, tested, and decorator-based (`@Throttle`, `@SkipThrottle`), which fits the project's NestJS-idiomatic style.
- It already solves the hard parts: per-route metadata resolution, multiple named throttlers, the `429` response with a `Retry-After` header, and a `ThrottlerStorage` seam for custom backends.
- A from-scratch guard would re-implement all of that and earn nothing. The only thing we genuinely need to own is the storage backend and the client-IP extraction — both are small extension points the library exposes.

### 2. Redis-backed storage over in-memory

Implement `ThrottlerStorage` against Redis (`RedisThrottlerStorage`) instead of using the library's default in-memory `ThrottlerStorageService`.

The default storage keeps counters in a per-process `Map`. That is correct for a single instance and wrong for a fleet (see Context constraint 1). Redis gives all replicas one shared counter per `(throttler, client-IP)` pair, so the limit holds regardless of which replica serves a request. The counter key is namespaced `throttle:<throttlerName>:<ip>` so the two named throttlers never collide.

### 3. Counter + TTL (fixed window) over a sorted-set sliding window

The storage is a fixed-window counter: one Redis key per `(throttler, IP)`, incremented per request, carrying a TTL equal to the window. The first hit in a window sets the TTL (atomically, see below); subsequent hits only `INCR`. When the counter exceeds the limit the client is blocked for the remainder of the window.

The considered alternative — a sorted set of request timestamps trimmed to a moving window (a true sliding window) — is more precise at window boundaries but costs O(requests) memory per client and O(log n) trim work per request. The fixed-window counter is one small integer key per active client, constant memory, O(1) per request. The accuracy cost is the classic fixed-window burst: a client can do up to `2 × limit` requests across a window boundary (limit at the end of window A, limit at the start of window B). For a defense layer protecting quota — not a billing meter — that ~1–2 % boundary imprecision is well worth the constant memory footprint. This matches how most production API gateways approximate rate limits.

### 4. Atomicity via a Lua `INCR` + first-hit `EXPIRE`

`incrementWithTtl` runs a two-line Lua script: `INCR` the key, and `if current == 1 then EXPIRE`. Two reasons it must be a script, not two round-trips:

- **Race safety.** A plain `INCR` followed by a separate `EXPIRE` has a window where a crash (or interleaving) between the two leaves a key with no TTL — a leaked counter that never resets, permanently throttling that client. The script makes the pair atomic.
- **Window anchoring.** Guarding `EXPIRE` behind `current == 1` means the TTL is set once, on the first request of the window, and never refreshed. Calling `EXPIRE` on every hit would slide the expiry forward continuously and a steadily-requesting client would never reset — effectively a permanent block. The window must anchor to the first request.

`RedisService` already exposed `eval()` (Sprint A's lock used compare-and-delete scripts); this sprint added a thin `pttl()` wrapper for reading the window's remaining time.

### 5. Fail-open on Redis unreachable

Every Redis error in the storage is swallowed: log a WARN and return a "not blocked" record so the request proceeds.

This mirrors Sprint A's fail-open stance exactly. Rate limiting is a **defense layer, not a correctness primitive**. If Redis is down, the right failure mode is "stop rate limiting" (the API keeps serving, briefly unprotected) rather than "stop serving" (Redis becomes a single point of failure that can take the whole API down). A throttle outage is an availability event for the *defense*, not for the *service*. The circuit breaker (ADR 0010) still guards the LLM, so an un-throttled burst during a Redis outage is bounded by other layers.

### 6. Trust proxy + custom `getTracker()`

In production the app runs behind a load balancer / reverse proxy. `req.ip` then reflects the proxy's address, so every client would share one bucket — the rate limit would be global, not per-client.

`main.ts` enables Express `trust proxy`, and `ProxyAwareThrottlerGuard` overrides `getTracker()` to read the first entry of `X-Forwarded-For` (the originating client in the `client, proxy1, proxy2` chain), falling back to `req.ip`, then to a literal `'unknown'` (a missing IP degrades to one shared bucket rather than throwing). The guard reads the header directly, so per-client tracking works even where `trust proxy` isn't wired (e.g. the integration tests).

### 7. Different limits per endpoint

Two named throttlers, env-driven:

| Throttler | Endpoint | Default limit | Why |
|---|---|---|---|
| `default` | `POST /api/v1/questions` | 30 / 60 s | A normal interactive question rate |
| `stream` | `GET /api/v1/questions/stream` | 5 / 60 s | SSE connections are long-lived and resource-heavier; a handful of concurrent streams per client is already generous |

Because `@nestjs/throttler` v6 applies **every** named throttler to **every** route by default, each endpoint scopes itself with `@SkipThrottle({ <name>: true })` so the two limits stay independent (see Adaptations).

### 8. Health endpoint bypassed

`GET /health` carries `@SkipThrottle({ default: true, stream: true })` — full bypass. Liveness/readiness probes and uptime monitors poll it frequently and from few IPs; throttling it would trip false alarms (a `429` reads as "unhealthy" to most monitors). Health is cheap and carries no LLM cost, so there's nothing to protect.

## Adaptations from the inline sprint plan

The plan's inline code conveyed intent; three things changed against the installed `@nestjs/throttler` v6.5.0:

- **`ThrottlerStorageRecord` times are returned in SECONDS, not milliseconds.** The guard copies `timeToBlockExpire` straight into the HTTP `Retry-After` header (defined in seconds), and the library's own in-memory storage returns these fields in seconds (its `getExpirationTime` divides by 1000). The plan's millisecond return would have made `Retry-After` 1000× too large (60000 instead of 60). Verified against the compiled `throttler.service.js` / `throttler.guard.js`.
- **Per-endpoint scoping is `@SkipThrottle`, not "no decorator" / hardcoded `@Throttle`.** In v6 all named throttlers apply to every route, so without `@SkipThrottle({ stream: true })` the question endpoint would be bound by the stricter `stream(5)` and capped at 5, not 30. The stream endpoint uses `@SkipThrottle({ default: true })` (keeping the env-driven `stream` config) instead of the plan's hardcoded `@Throttle({ stream: { ttl: 60_000, limit: 5 } })`, which would duplicate config and violate the no-magic-numbers rule. Health needs both names listed explicitly — bare `@SkipThrottle()` defaults to `{ default: true }` only and would leave the custom `stream` throttler binding the route (caught by the integration test).
- **Storage is constructed in the `forRootAsync` factory from an injected `RedisService`**, not DI-injected by class token. `forRootAsync`'s internal module resolves its `inject` array only against its own `imports`; the outer module's providers aren't visible there, so the plan's `inject: [ConfigService, RedisThrottlerStorage]` wouldn't resolve. The storage is stateless, so constructing it from the injected (and `RedisModule`-exported) `RedisService` is the robust idiom.

## Honest acknowledgments

- **Fixed-window burst.** A client can send up to `2 × limit` requests across a window boundary. Accepted (decision 3). If a future phase needs strict smoothing, the storage seam allows swapping in a sliding-window or token-bucket implementation without touching the guard or controllers.
- **Fail-open is a real gap.** During a Redis outage the endpoints are un-throttled. This is a deliberate availability-over-protection choice (decision 5); the LLM circuit breaker still bounds the blast radius.
- **`X-Forwarded-For` is spoofable** when the app is *not* actually behind a trusted proxy. `trust proxy` should only be enabled in deployments where a trusted LB sets the header; otherwise a client can forge it to dodge or poison limits. This is the standard proxy-trust caveat, not unique to us.
- **No per-replica circuit state federation needed here** — unlike the circuit breaker (intentionally process-local, ADR 0010), rate-limit counters are intentionally shared, because the limit is a property of the client, not of one replica's view of upstream health.

## Out of scope (deferred, with reasons)

- **Global rate limit across all IPs** (Senaryo 2) — a fleet-wide ceiling independent of per-IP limits. Deferred; per-IP is the higher-value first cut and the global cap is additive later.
- **Concurrent stream limit** (Senaryo 4) — capping simultaneous open SSE connections per client (a gauge, not a rate). Different mechanism (needs connection-lifecycle tracking, not a counter); deferred.
- **Token-based rate limiting** (Senaryo 5) — limiting by Gemini tokens consumed rather than request count. Depends on integrating Sprint Token's `TokenUsageService` into the limit path, which we explicitly don't want to couple yet.
- **Tiered limits (anonymous vs authenticated)** (Senaryo 6) — no auth layer exists in the project, so there's no identity to tier on.
- **A `/metrics` endpoint for throttle events** — operator visibility currently rides WARN logs (fail-open events) and the `429` responses themselves; a metrics surface is Phase 1.7.5 territory.

## Consequences

- The API is protected against single-client quota exhaustion on both LLM endpoints, correctly across replicas.
- Limits are tunable per deployment via four `THROTTLE_*` env vars — no code change to retune.
- A new dependency (`@nestjs/throttler`) and a new module (`ThrottlerModule`) join the graph; the storage cleanly reuses Sprint A's `RedisService` (only a `pttl()` wrapper added).
- The `ThrottlerStorage` seam keeps the door open for a different algorithm (sliding window, token bucket) without disturbing the guard, decorators, or controllers.
- Redis is now load-bearing for two concerns (ingestion lock + rate limiting), but fail-open on both means a Redis outage degrades gracefully rather than taking the service down.
