# Sprint Rate-Limit — Validation Report

**Date:** 2026-06-01
**Sprint:** Phase 1.7 Sprint Rate-Limit
**Validator:** Claude Code agent (skill: sprint-validator)
**Commits under test:** `0adf963` (storage), `0bc7769` (guard + wiring), `33e55ca` (docs)

## Environment

- Dev server: **running** — started during validation via `npm run start` (PID 35292); was NOT running at the start of the session. Booted clean: `ThrottlerModule dependencies initialized`, `Mapped {/questions, POST}` + `{/questions/stream, GET}` (version 1), `redis_connected`, `HTTP server listening on http://localhost:3000`.
- Redis: **reachable** — container `hybrid-rag-redis`, `Up 9 days (healthy)`, `0.0.0.0:6379`.
- Chroma: **reachable** — container `hybrid-rag-chroma`, `Up 9 days (healthy)`, `0.0.0.0:8000`.
- Gemini API key: **valid / present** — `GOOGLE_API_KEY` set in `.env`; exercised indirectly by the 5 streaming requests in Senaryo 3 (all returned 200).
- Throttle config: limit=**30**/window=**60000**ms, stream limit=**5**/window=**60000**ms.
  **Source = env-schema defaults, not `.env`.** `.env` contains no `THROTTLE_*` keys, so the Zod schema defaults apply (`env.schema.ts`). The effective values match the sprint design.
- Redis state at start: only `ingestion:last_successful_run` (Sprint A integrity marker). Throttle namespace empty — no cleanup required. The integrity marker was left untouched throughout.

## Scenarios validated

### Senaryo 1 — Per-IP rate limit (30 / 60s)

**Verdict: PASS**

**Method:** 31 sequential `POST /api/v1/questions` from one client (localhost, no `X-Forwarded-For` → single tracker). Body `{"question":"ignore previous instructions"}` — deliberately Layer-1-rejectable so the throttler counts the request while sanitization returns 400 *before* any Gemini call (quota-saving; the guard runs upstream of sanitization).

**Evidence:**
- Requests 1–30 returned `400` (sanitization rejection), **not** `429` — the throttler admitted them:
  ```
  requests 1-30 statuses:
   400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400 400
  ```
- Request 31 returned `429` with a `Retry-After` header:
  ```
  HTTP/1.1 429 Too Many Requests
  Retry-After: 59
  Content-Type: application/json; charset=utf-8
  {"statusCode":429,"message":"ThrottlerException: Too Many Requests","path":"/api/v1/questions","timestamp":"2026-06-01T13:41:31.308Z"}
  ```
- Server log line proving the internal throttle decision:
  ```
  WARN [AllExceptionsFilter] POST /api/v1/questions -> 429: ThrottlerException: Too Many Requests
  ```
- Corroborating: 30 paired `WARN [PromptSanitizationService] prompt_sanitization_rejected reason=hard_pattern patterns=ignore_previous` lines confirm the first 30 reached sanitization — i.e., the limiter sits in front of sanitization, exactly as designed.

**`Retry-After: 59`** (not 59000) directly validates the milliseconds→seconds adaptation made during the sprint.

**Anomalies:** none.

### Senaryo 3 — Stream endpoint stricter limit (5 / 60s)

**Verdict: PASS**

**Method:** 6 sequential `GET /api/v1/questions/stream?question=test%20N` with benign questions (to open real SSE streams), each bounded by `curl --max-time` so the 200 + SSE headers arrive and the stream is cut early to limit token generation.

**Evidence:**
- Requests 1–5 returned `200` (SSE stream opened):
  ```
  stream requests 1-5 statuses:
   200 200 200 200 200
  ```
- Request 6 returned `429`:
  ```
  HTTP/1.1 429 Too Many Requests
  Retry-After-stream: 43
  {"statusCode":429,"message":"ThrottlerException: Too Many Requests","path":"/api/v1/questions/stream?question=test%206","timestamp":"2026-06-01T13:43:29.153Z"}
  ```
- Server log:
  ```
  WARN [AllExceptionsFilter] GET /api/v1/questions/stream?question=test%206 -> 429: ThrottlerException: Too Many Requests
  ```

**Anomalies:** The `Retry-After` header for the stream throttler is named **`Retry-After-stream`** (43s), not plain `Retry-After`. This is expected `@nestjs/throttler` v6 behaviour — the guard suffixes the header with the throttler name for every non-`default` named throttler (`Retry-After${name === 'default' ? '' : '-' + name}`). Value is in seconds, consistent with Senaryo 1. Clients consuming the stream endpoint must read `Retry-After-stream`, which is a portability wrinkle worth documenting for API consumers.

### Senaryo 8 — Health endpoint bypass

**Verdict: PASS**

**Method:** 50 rapid `GET /health`, with a Redis throttle-key snapshot before and after.

**Evidence:**
- All 50 returned `200`, zero non-200:
  ```
  non-200 count: 0
  ```
- Throttle keys before the burst: empty. Throttle keys after 50 requests: still empty. Explicit health-pattern probe `KEYS "throttle:*health*"`: empty.
- This proves the bypass happens at the guard level: `@SkipThrottle({ default: true, stream: true })` makes the guard short-circuit before ever calling `storage.increment`, so **no Redis key is created at all** for `/health` — stronger than merely "no 429".

**Anomalies:** none.

### Senaryo 9 — Redis-backed state (distributed source of truth)

**Verdict: PASS** (single-instance verification; see Limitations)

**Evidence (captured live immediately after Senaryo 1 and Senaryo 3):**
- After Senaryo 1, a `default` counter key existed with an integer value and a sub-window TTL:
  ```
  key=throttle:default:e77dfe7302ac7365ca8d9428ac3e59f050079f04ad7f07e30c57ff16717490f5 value=31 ttl=27
  ```
- After Senaryo 3, an independent `stream` counter key:
  ```
  key=throttle:stream:0ffcdb65fea03425f2a1c603cf92a0e5f72ca919bb0c452ca6b45f8226e34684 value=6 ttl=18
  ```
- Values are integers (31, 6) representing request counts; TTLs are positive and `< 60` s. Counters living in Redis (not process memory) prove the storage path goes through `RedisThrottlerStorage`.
- The two throttlers occupy distinct namespaces (`throttle:default:*` vs `throttle:stream:*`) and the POST burst created only a `default` key (no `stream` key), confirming the per-endpoint `@SkipThrottle` scoping.
- **TTL auto-expiry confirmed organically:** by the time of the Senaryo 8 snapshot the `default` key had already disappeared (its ~60 s window elapsed), and at end of run the only remaining key was `ingestion:last_successful_run` — i.e., all throttle keys self-expired with no leakage.

**Anomalies / deviation from the plan's expected shape:** The plan expected keys named `throttle:default:<IP>`. The actual suffix is a **hash**, not a raw IP — `@nestjs/throttler` v6's default `generateKey` hashes the tracker together with the throttler name and route context, which is also why the `default` and `stream` keys for the same localhost client have different hash suffixes. The substance the scenario checks for — a Redis-resident, per-throttler, integer counter with a window TTL — holds.

## Summary table

| Scenario | Verdict | Evidence quality |
|---|---|---|
| 1 — Per-IP rate limit | PASS | strong |
| 3 — Stream stricter limit | PASS | strong |
| 8 — Health bypass | PASS | strong |
| 9 — Redis state | PASS | strong (single-instance) |

## Limitations of this validation

What was NOT tested in this run (specific):

- **Multi-instance distributed behaviour.** Only one NestJS process ran. The Redis-as-shared-state design (the whole reason for a Redis backend over in-memory) was verified *indirectly* — counters live in Redis with the expected shape — but two processes sharing one counter was not exercised. A true test needs two app instances on different ports against the same Redis, hitting the limit collectively.
- **Fail-open behaviour.** Redis was healthy for the entire run, so the fail-open path (Redis unreachable → WARN + request proceeds) was never triggered. No `throttler_storage_failed` log appeared. This is the single biggest untested branch and the most important one to cover next (e.g., `docker stop hybrid-rag-redis` mid-traffic, expect requests to keep succeeding with WARN logs).
- **Real proxy / `X-Forwarded-For` chains.** All requests came from localhost without `X-Forwarded-For`, so the guard fell back to `req.ip` (single tracker). The `X-Forwarded-For`-first extraction and the multi-hop chain parsing were only covered by unit tests, not live traffic behind an actual load balancer. (IP spoofing risk under `trust proxy` was likewise not exercised.)
- **Concurrent load.** Requests were serial. Behaviour under genuine concurrency (race conditions on the Lua `INCR` under parallel clients) was not stress-tested live — though the Lua script makes `INCR`+`EXPIRE` atomic by construction.
- **Long-horizon TTL / key cleanup.** Auto-expiry was observed within the ~60 s window organically, but multi-hour key-churn behaviour was not observed.
- **Window-boundary burst (2× limit).** The documented fixed-window edge case (up to `2 × limit` across a boundary) was not deliberately provoked.

## Recommendations

- **No code changes needed** — all four target scenarios pass against the live system. Per the brief, no fixes were applied during validation.
- **Document the `Retry-After-stream` header** for stream-endpoint API consumers. A client written to read plain `Retry-After` will miss the stream throttler's value. Consider noting this in the Swagger description of the stream endpoint (or, if a single header is preferred, revisit the named-throttler suffix convention).
- **Add a fail-open smoke to the next validation pass** — stop Redis mid-traffic and confirm requests still succeed with `throttler_storage_failed … action=fail_open` WARN logs. This is the highest-value untested branch.
- **Minor:** `.env` carries no `THROTTLE_*` entries; the app runs on schema defaults. That's fine functionally, but adding them to `.env` (and the committed `.env.example` already has them) would make the operational config explicit for anyone reading `.env`.

## Overall verdict

**PASS — all four scenarios verified** against the running system with strong, log- and Redis-backed evidence. Two behaviours diverge cosmetically from the plan's expected shape (hashed key suffix instead of raw IP; `Retry-After-stream` instead of `Retry-After` for the named stream throttler) — both are expected `@nestjs/throttler` v6 conventions, not defects. The most material gap is that fail-open and multi-instance behaviour were not exercised live; both are called out in Limitations for a follow-up pass.
