# Sprint Cache — Validation Report

**Date:** 2026-06-02
**Sprint:** Phase 1.7.5 Sprint Cache (Cache C — LLM response cache)
**Validator:** Claude Code agent (skill: sprint-validator, third use)
**Commits under test:** `180d3dc` (QaResponseCacheService) · `1ee1fae` (ask() integration) · `b1ebb90` (docs/ADR-0016)

---

## Environment

- **Dev server:** running — started during validation (`npm run start`, PID 37996); was not running at first check. Health 200, `{"status":"ok","services":{"redis":"up"},"ingestion":{"active":false}}`.
- **Redis:** reachable (`PONG`); persistence on (keys survived a container restart).
- **Chroma:** reachable (`heartbeat` OK); collection `podcasts`, **53,427 chunks**, integrity gate passed at boot (`integrity_check_passed marker_chunks=53427 chroma_chunks=53427`).
- **Gemini API key:** valid — real embeddings and real chat completions observed (`input_tokens=1272 output_tokens=193` on first answer).
- **Cache config:** `CACHE_TTL_SECONDS=3600`, prompt hash `5f2ba2d9`, ingestion-timestamp marker present (`2026-05-23T15:00:00Z`, used in every key).
- **Initial `qa:v1:*` key count:** 0 (clean slate — no pre-existing entries to confound results).

All four dependencies healthy before scenarios began. No broken-environment stop condition.

---

## Scenarios validated

### Scenario 1 — Cache miss then cache hit

**Verdict:** PASS (cache mechanics) — with a documented latency caveat (the literal "5× faster" criterion is not architecturally reachable).

**Evidence (server logs, authoritative):**

- First request — `qa_cache_miss correlation_id=45635506… cache_key=qa:v1:gemini-2.5-flash-lite:0:5f2ba2d9:5:2026-05-23T15:00:00Z:9b9ee6c0…` → `qa_cache_stored … ttl_seconds=3600` → `qa_complete duration_ms=1458 sources=5 … cache=miss input_tokens=1272 output_tokens=193 total_tokens=1465`.
- Second request (immediate) — `qa_cache_hit correlation_id=7b554f2e… cache_key=…9b9ee6c0…` (**same key**) → `qa_complete correlation_id=7b554f2e… duration_ms=2859 sources=5 cache=hit input_tokens=0 output_tokens=0 total_tokens=0`.
- Response bodies **byte-identical** (3418 bytes).

**Anomaly investigated:** the immediate hit (2859 ms) was *slower* than the miss (1458 ms). Root cause from `retrieve_complete` lines: the hit's query embedding took `embed_ms=2847` vs the miss's `embed_ms=494`. Query embedding runs **before** the cache lookup (ADR-0016 decision 4: the key needs the retrieved chunk IDs), and the `EMBEDDING_REQUESTS_PER_MINUTE=15` token bucket (~4 s spacing) throttled the back-to-back second embedding. A third, **spaced** request to the same cached question embedded in `embed_ms=433` → `qa_complete duration_ms=444 cache=hit … 0 tokens` = **3.3× faster** than the miss, with an identical body.

**Conclusion:** the cache always skips the LLM correctly (proven by `cache=hit` + zero tokens + byte-identical body). The wall-clock benefit is real (~1 s LLM + all tokens saved) but is gated by — and can be entirely masked by — query-embedding latency, which the cache does not (and by design cannot) avoid. The ~250 ms net-hit-latency figure in ADR-0016 holds only when embedding is fast and un-throttled.

### Scenario 2 — Redis state inspection

**Verdict:** PASS

**Evidence:**

- `KEYS qa:v1:*` → 1 entry (`…:9b9ee6c0…`).
- `TTL` = **3434 s** (positive, near the 3600 default — consistent with elapsed time since write).
- `STRLEN` = 3472 bytes; `GET` is JSON-parseable.
- JSON field check: `answer` ✓, `sources` ✓ (5 items, each `{chunkId, score, excerpt, metadata}`), `chunksCount` = 5 ✓, `cachedAt` = `2026-06-02T11:54:31.069Z` ✓.

### Scenario 3 — Different question, different key

**Verdict:** PASS

**Evidence:** `"What is artificial intelligence?"` → `qa_cache_miss correlation_id=012e23a2… cache_key=…:251d112c…` → `qa_complete duration_ms=1502 … cache=miss input_tokens=1248 output_tokens=152 total_tokens=1400`. Key count **1 → 2**; the new content hash (`251d112c…`) is distinct from consciousness (`9b9ee6c0…`); the `model:temperature:promptHash:topK:ingestionTimestamp` prefix is identical, as expected.

### Scenario 4 — Empty-result fast path not cached

**Verdict:** SKIPPED — could not construct an empty-result case via the HTTP API.

**Reason:** Retrieval over 53,427 chunks returns the top-K (5) for any semantically non-empty query; there is no metadata filter exposed on the endpoint to force zero results, and the retrieval validation layer rejects sub-3-char queries with a 400 *before* retrieval runs. Forcing a 0-chunk result would require a code change, which the validation rules forbid. The behavior is covered by the unit test `does NOT touch the cache on the empty-retrieval fast path` (asserts `cache.get`/`cache.set` are never called when `chunks.length === 0`).

### Scenario 5 — Case and whitespace normalization

**Verdict:** PARTIAL (fails the scenario's literal "all four hit" criterion; the underlying behavior is correct by design).

**Evidence:** four variants of the consciousness question sent back-to-back; key count went **2 → 4**.

| Variant | Result | Content hash |
|---|---|---|
| `"WHAT IS CONSCIOUSNESS?"` | **MISS** (new key) | `e0379c7e…` |
| `"what is consciousness?"` | HIT | `9b9ee6c0…` (original) |
| `"  What is consciousness?  "` | HIT | `9b9ee6c0…` (original) |
| `"What Is Consciousness?"` | **MISS** (new key) | `e795a5f3…` |

**Root cause (proven):** the cache key is `hash(normalizedQuestion + sortedChunkIds)`. `toLowerCase().trim().normalize('NFC')` makes the question component identical for all four — but the chunk IDs come from **case-sensitive embedding retrieval**. Comparing the cached `sources` across the three keys shows the retrieved sets genuinely diverge:

- `9b9ee6c0` (orig/lowercase/whitespace): `2_chunk_7, 215_chunk_19, 107_chunk_21, 2_chunk_24, 69_chunk_39`
- `e0379c7e` (ALL CAPS): `2_chunk_7, 215_chunk_19, 2_chunk_24, 69_chunk_39, **317_chunk_25**`
- `e795a5f3` (Title Case): `2_chunk_7, 107_chunk_21, 215_chunk_19, 2_chunk_24, **317_chunk_25**`

ALL-CAPS and Title-Case each swapped the 5th chunk, so by the exact-match contract (ADR-0016 decision 1: a cached answer is only valid for the exact retrieved chunk set) they correctly get their own entries. **This is not a correctness bug** — it is the conservative exact-match design working — but it means question normalization does **not** guarantee a cache hit for differently-cased repeats; retrieval stability is the real gate. The unit tests didn't surface this because they hold `chunkIds` fixed in `BuildKeyInput`.

### Scenario 6 — Fail-open on Redis unreachable

**Verdict:** SPLIT — PASS for Redis *crash*, **FAIL for Redis *hang***. This is the headline finding.

**6a — `docker pause` (silent/unresponsive Redis):** request hung the full **30 s** and returned **HTTP 000** (no body). No `qa_start` was logged → the hang occurred *before* `QaChainService.ask()`, in an earlier Redis touchpoint (the global `ProxyAwareThrottlerGuard` / `RedisThrottlerStorage`, and/or the lock check). A paused container keeps the TCP socket open but never replies, and the ioredis client has **no `commandTimeout`** configured, so the command blocks indefinitely. Fail-open never engaged because nothing threw. The server recovered cleanly after `unpause` (a later request completed as `cache=hit duration_ms=439`).

**6b — `docker stop` (clean crash, TCP RST → "Redis is unreachable"):** request returned **HTTP 200 in 3661 ms** with a real 3418-byte answer. Every Redis-dependent layer fail-opened, logged in one request:

```
RedisThrottlerStorage   throttler_storage_failed … action=fail_open
QaChainService          qa_lock_check_failed … action=proceeding (Redis fail-open)
QaResponseCacheService  qa_cache_ingestion_marker_read_failed action=fail_open
QaResponseCacheService  qa_cache_failed action=fail_open … stage=read
CircuitBreakerService   circuit_storage_failed action=fail_open
QaResponseCacheService  qa_cache_failed action=fail_open … stage=write
QaChainService          qa_complete duration_ms=3636 … cache=miss input_tokens=1272 output_tokens=193 total_tokens=1465
```

Note the cache key during the outage carried `ingestionTimestamp=none` (marker read fail-open fallback), and both cache `stage=read` and `stage=write` fail-opened. The request still produced a grounded answer.

**Conclusion:** the cache's own fail-open logic is correct and proven live for the error case. But end-to-end, fail-open protects against Redis being **down** (connection refused/reset → immediate error), **not** against Redis being **up-but-unresponsive** (paused / network partition → silent), where requests block until a client/socket timeout. This gap is system-wide (throttler, lock, circuit, cache all share the same un-timed ioredis client), not specific to the cache.

### Scenario 7 — TTL expiry

**Verdict:** SKIPPED — verifying the full 3600 s window is impractical in this run. Proxy check (TTL positive and ≈3600 immediately after write) was satisfied in Scenario 2 (`TTL=3434`).

---

## Summary table

| Scenario | Verdict | Evidence quality |
|---|---|---|
| 1 — Miss then hit | PASS (mechanics); 5× latency target not reachable | strong |
| 2 — Redis state | PASS | strong |
| 3 — Distinct keys | PASS | strong |
| 4 — Empty-result not cached | SKIPPED (can't force via API; unit-tested) | n/a |
| 5 — Normalization | PARTIAL (2/4 hit; correct by exact-match design) | strong |
| 6 — Fail-open | PASS (crash) / FAIL (hang) | strong |
| 7 — TTL expiry | SKIPPED (1 h wait) | n/a |

---

## Limitations of this validation

- **TTL expiry** over the full 1-hour window not observed (only initial TTL positivity).
- **Multi-instance shared-cache** behavior not tested — a single NestJS process was running, so cross-replica hits couldn't be exercised.
- **Ingestion-event auto-invalidation** not exercised — would require running an ingestion mid-validation to change `ingestion:last_successful_run` and confirm the whole cache is bypassed.
- **Concurrent load** on the same key (thundering-herd / cache-stampede on a cold key) not simulated.
- **Corrupt-entry self-heal** (`qa_cache_corrupt_entry` → delete → miss) not triggered live (would require injecting malformed JSON into a Redis key); it is unit-tested.
- **Empty-result non-caching** (Scenario 4) verified only at unit level, not live.
- Latency numbers are influenced by the shared Gemini embedding rate-limiter and live Gemini latency, which vary run-to-run.

---

## Recommendations

1. **(Operational, medium severity) Set an ioredis `commandTimeout`.** The Scenario-6 hang shows fail-open does not protect against an unresponsive-but-connected Redis (pause / partition / GC pause). Without a per-command timeout, every Redis touchpoint (throttler guard, lock, circuit, cache) blocks the request until the client gives up. Adding `commandTimeout` (e.g. 1–2 s) to the ioredis client in `RedisService` would convert a hang into a thrown error, letting the existing fail-open paths engage. This is a `RedisService`-level fix that benefits all four Redis consumers, not just the cache. **Reported, not fixed** (validation rule).
2. **(Documentation) Note the normalization/retrieval interaction in ADR-0016.** The ADR's "normalization folds trivial question variants onto one key" is only true when retrieval returns the same chunks. Scenario 5 shows ALL-CAPS/Title-Case can diverge. Worth a one-line honesty note that case-folding in the key is best-effort and gated by embedding case-sensitivity.
3. **(Expectations) The hit-latency win is embedding-bound.** Because retrieval (query embedding) runs before the lookup and is rate-limited, repeated identical queries fired in a tight burst can be *slower* than a miss. The cache's value is token/cost savings and latency-under-fast-embedding; it is not a guaranteed latency win on every hit. ADR-0016 already documents the ~250 ms figure honestly; this run confirms it and adds the throttle caveat.
4. **(Optional test gap) Add a live or integration test for corrupt-entry self-heal and empty-result non-caching** to complement the unit coverage.

---

## Overall verdict

**PARTIAL — 3 of 5 executed scenarios pass cleanly; the two "failures" are both understood and neither is a cache-correctness defect.**

- The core cache contract is **solid and proven live**: deterministic content-hash keys, correct miss→store→hit lifecycle, byte-identical cached responses, zero LLM tokens on hit, correct `cache=hit|miss` logging, distinct keys per question, TTL≈3600, all four JSON fields persisted, and the ingestion-timestamp + prompt-hash key segments behaving as designed.
- Scenario 5 (normalization) "fails" only the optimistic expectation; the actual behavior — separate entries for genuinely different retrieved contexts — is the exact-match design being correctly conservative.
- Scenario 6 surfaces one **real, actionable operational gap** that is **not specific to this sprint**: fail-open covers Redis crash but not Redis hang, due to a missing ioredis `commandTimeout`. Recommend addressing in a small follow-up to `RedisService`.

The Sprint Cache implementation does what it was designed to do. Ship-worthy, with the `commandTimeout` recommendation tracked as a cross-cutting Redis hardening follow-up.
