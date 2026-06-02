# ADR 0015 — Redis-backed distributed circuit breaker state

- **Status:** Accepted
- **Date:** 2026-06-02
- **Phase:** 1.7.5 Sprint Distributed-Breaker (2 steps + docs)
- **Related:** ADR 0010 (Sprint Retry — the original in-memory `CircuitBreakerService` this migrates), ADR 0014 (Sprint Rate-Limit — same Redis + Lua + fail-open patterns), Phase 1.7.5 Sprint A (`RedisService`, `eval`, the fail-open philosophy)
- **Supersedes:** the "state is in-memory per process" decision recorded in ADR 0010 / the original `CircuitBreakerService` class comment.

---

## Context

The Phase 1.6 `CircuitBreakerService` (ADR 0010) kept its entire state — the CLOSED/OPEN/HALF_OPEN machine, the rolling failure-timestamp window, the `openedAt` marker, and the half-open single-flight flag — in `private` instance fields. That is correct for a single process and wrong for the multi-instance deployment the project targets (N replicas behind a load balancer).

With per-process state, each replica observes upstream health independently. A known-broken Gemini endpoint gets hammered by every replica until each one independently accumulates enough failures to trip its own circuit — exactly the thundering-herd the breaker exists to prevent. In the 100k-user analysis from the sprint discussion, this is the difference between "one replica probes the recovering upstream" and "every replica probes simultaneously."

The project already runs Redis (Phase 1.7.5 Sprint A) and already uses Lua-scripted atomic operations there (`DistributedLockService`) and in Sprint Rate-Limit (`RedisThrottlerStorage`). Circuit state is the same kind of shared, ephemeral, cross-replica coordination data. Migrating it to Redis gives one shared circuit: when any instance trips it, all instances immediately respect it.

## Decision

### 1. Migrate state to Redis, keep the public contract

`CircuitBreakerService.execute()` keeps its exact signature and three-state semantics. Only the storage moves: a new internal `CircuitBreakerRedisStorage` owns the Redis side, and the service delegates to it. `ResilientLlmService` (both `invokeChain` and `streamChain`) is untouched — it still just calls `circuitBreaker.execute(...)`. `CircuitOpenException` is byte-for-byte unchanged.

### 2. Five separate keys, not one JSON blob

State lives in five keys under `circuit:llm:`:

| Key | Type | Holds |
|---|---|---|
| `state` | string | `CLOSED` \| `OPEN` \| `HALF_OPEN` (absent ⇒ CLOSED) |
| `failure_timestamps` | sorted set | failure events scored by ms epoch |
| `opened_at` | string | ms epoch of the last OPEN transition |
| `half_open_probe_token` | string | single-flight probe lock (`SET NX PX`) |
| `state_changed_at` | string | ms epoch of the last transition (diagnostics) |

A single JSON blob would force read-modify-write: read the blob, mutate a field, write it back — a race window across instances where two replicas read the same blob and clobber each other's update. Separate keys let each operation touch exactly the fields it needs (`ZADD` a failure, `SET NX` a probe token) with native Redis atomicity. The sorted set in particular gives O(log n) windowed-failure pruning (`ZREMRANGEBYSCORE`) that a JSON array couldn't.

### 3. Lua scripts for multi-step transitions

Three (plus a read-only fourth) Lua scripts perform every transition atomically inside Redis:

- **evaluate-and-acquire-probe** — prune the window, read state, and gate the caller. The probe **token** (`SET NX`) is the single-flight mechanism: CLOSED proceeds; OPEN still cooling down is blocked with `retryAfterMs`; OPEN-cooled-down *or* HALF_OPEN race for the token — the winner becomes the one probe-holder (state → HALF_OPEN), everyone else is reported as OPEN.
- **record-failure** — `ZADD` (unique member), prune, then trip to OPEN on either a failed HALF_OPEN probe or a threshold breach.
- **record-probe-success** — full `DEL` of all keys → implicit-CLOSED baseline.
- **read-snapshot** — read-only diagnostics for `getSnapshot()`.

Each multi-step decision (read state → check cool-down → claim probe → write new state) must be atomic, or two instances interleaving the steps could both acquire a probe, or both trip, or one's write could be lost. A Lua script runs as a single isolated Redis operation, which is the simplest correct primitive — the same approach `DistributedLockService` uses for compare-and-delete.

### 4. The probe token is the single-flight gate (deviation that fixed a real bug)

The inline sprint plan blocked non-probe callers only when `state == OPEN`. But once the first caller promotes OPEN → HALF_OPEN, a *second* concurrent caller reads `state == HALF_OPEN` — and the service's `execute()` only short-circuits on OPEN, so that second caller would have run the operation, defeating single-flight. The live integration test caught this.

Fix: route both "OPEN cooled down" and "already HALF_OPEN" through the same `SET NX` token acquisition. Whoever wins the token is the probe-holder (HALF_OPEN); everyone else is reported as **OPEN** (blocked). The service's invariant becomes "`state === HALF_OPEN` ⇒ this caller is the probe-holder," which keeps `execute()` simple. A bonus: because the token carries `PX openDurationMs`, a probe-holder that crashes mid-probe lets the token expire, and the next caller wins a fresh probe instead of the circuit wedging in HALF_OPEN forever.

### 5. Fail-open when Redis is unreachable

If `evaluateAndAcquireProbe` throws (Redis down), the service logs `circuit_storage_failed action=fail_open` and runs the operation **unprotected**. If recording a failure throws, the original operation error is still propagated (recording is best-effort). Same philosophy as Sprint A's lock and Sprint Rate-Limit's storage: the circuit is a coordination *optimisation*, not a correctness primitive. A Redis outage must not take the LLM path down — it should degrade to "no circuit protection," which is exactly the pre-Phase-1.6 behavior. The retry layer (`RetryPolicyService`, unchanged) still bounds individual call failures.

### 6. TTLs on every key (`max(windowMs, openDurationMs) × 4`)

Every mutating script `PEXPIRE`s the keys it touches with `max(windowMs, openDurationMs) × 4` (4 minutes at default config). Without TTLs, a circuit that trips OPEN and then sees no traffic (idle period, or the upstream is only used intermittently) would keep its OPEN state forever, blocking the first request after a long quiet spell even though the cool-down elapsed ages ago. The `× 4` multiple is comfortably longer than a full open→half-open→closed cycle so live state is never evicted mid-cycle, but short enough that genuinely stale state self-heals. `record-probe-success` sidesteps the question entirely by `DEL`-ing everything.

## Adaptations from the inline plan

- **`evaluateAndAcquireProbe` drops the `failureThreshold` parameter** — the threshold only matters when *recording* a failure, never when evaluating. Carrying it would be a dead parameter.
- **`record-probe-success` fully `DEL`s all five keys** instead of `SET state=CLOSED` + `SET state_changed_at`. Avoids a lingering key and the awkward "what TTL?" question for a method that has no window/duration arguments. No behavioral loss — the service logs the close transition itself.
- **Probe token as the universal single-flight gate** (decision 4) — fixes the HALF_OPEN second-caller bug the plan's `state == OPEN`-only check missed.
- **`OPEN → HALF_OPEN` promotion now happens inside Lua**, so the service logs that transition (`reason=cooldown_elapsed`) at probe-acquisition time to keep observability symmetric; all other log shapes are unchanged.

## Acknowledged limitations

- **Probe-token race if a probe outlives its TTL.** The token expires after `openDurationMs`. If a probe operation runs longer than that (e.g., an LLM call near the 30 s timeout), the token can expire while the probe is still in flight, and a second caller could win a fresh token — two concurrent probes. Rare (probe duration ≈ LLM latency ≪ default 30 s open duration) and self-correcting; accepted.
- **Redis flush / data loss mid-probe.** If Redis is flushed or fails over to an empty replica while a probe is in flight, the probe token vanishes and multiple instances could race to probe the recovering upstream. Documented and accepted as a rare edge case — the blast radius is bounded by the retry layer and the upstream's own capacity.
- **Clock skew across instances.** `now` is each instance's `Date.now()`, passed into the script. Cool-down math (`now - openedAt`) can be off by the inter-instance clock skew. Sub-second skew on coordinated hosts is negligible against a 30 s cool-down; accepted rather than introducing a Redis `TIME`-based clock dependency.
- **Not yet validated across two live processes.** The single-process Lua behavior is covered by `circuit-breaker-redis.storage.integration.spec.ts` (live Redis); the cross-instance guarantee follows from shared state but a two-process smoke (trip from A, observe instant block on B) is left as a future validation task — a natural fit for the `/validate-sprint` agent.

## Out of scope (deferred, with reasons)

- **Per-error-type circuits** — separate breakers for 429 vs 5xx vs timeout. The single circuit over all failures is sufficient for the current single-upstream (Gemini) design; splitting adds keys and config for no present benefit.
- **An observable metrics endpoint for circuit state** — `/metrics`-style exposure of trips/probes/state. Deferred to Phase 5; `getSnapshot()` already provides the read model when one is needed.
- **A circuit-state UI / admin surface** — out of scope for a backend portfolio artifact.

## Consequences

- One shared circuit across all replicas: a trip anywhere is honored everywhere, and exactly one probe runs cluster-wide during recovery.
- Redis is now load-bearing for three concerns (ingestion lock, rate limiting, circuit state); all three fail open, so a Redis outage degrades each gracefully rather than taking the service down.
- The `CircuitBreakerRedisStorage` seam keeps the Lua isolated and unit-testable (mocked `eval`) with the real state machine covered by a live-Redis integration spec.
- `getSnapshot()` became async; it has no external callers today, so the change is contained, and it now reflects the shared circuit rather than one process's view.
