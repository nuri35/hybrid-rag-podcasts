# ADR 0016 — LLM response cache (exact-match, Redis-backed)

- **Status:** Accepted
- **Date:** 2026-06-02
- **Phase:** 1.7.5 Sprint Cache (Cache C) (2 steps + docs)
- **Related:** ADR 0007 (QA chain — the `ask()` flow this wraps), ADR 0013 (prompt-security — the `QA_PROMPT_TEMPLATE` now shared with the cache key), ADR 0014 / ADR 0015 (Redis + fail-open patterns), Phase 1.7.5 Sprint A (`RedisService`, the `ingestion:last_successful_run` marker, the fail-open philosophy)

---

## Context

Every non-streaming QA request costs ~2.5 s, of which ~2.4 s is the Gemini
chat call; retrieval (embed + Chroma) is the remaining ~230 ms. With
`LLM_TEMPERATURE=0` the model is deterministic — the same prompt produces a
byte-identical answer (confirmed in Phase 1.7 Test 8). Repeated identical
questions therefore re-pay the full LLM latency and burn Gemini quota for an
answer we already computed.

Three real wins motivate a cache: **latency** (a hit collapses the LLM call),
**cost** (~30 % fewer chat tokens at a moderate hit rate), and **abuse
coverage** (spam / repeated-query floods get served from cache for free).

The project already runs Redis (Sprint A) and already leans on it for
cross-instance coordination (lock, rate-limit, circuit breaker). A
Redis-backed cache is shared across replicas with no extra infrastructure.

## Decision

### 1. Exact-match caching, not semantic caching

The cache hits only when the **exact** normalized question + the **exact**
retrieved chunk set recur. We deliberately do **not** do semantic caching
(embedding the question and serving the nearest cached neighbour above a
similarity threshold). Semantic caching trades correctness for hit rate: two
questions can be close in embedding space yet require materially different
answers ("What did X say about Y?" vs "What did X say about Z?"), and serving
the wrong cached answer silently violates the project's grounding guarantee.
Exact-match can only ever return the answer that was actually generated for
those inputs. Correctness first; a lower hit rate is the acceptable cost.

### 2. Cache key shape

```
qa:v1:{model}:{temperature}:{promptHash}:{topK}:{ingestionTimestamp}:{contentHash}
```

`contentHash = SHA256( normalize(question) + "|" + sorted(chunkIds).join(",") )`
where `normalize = toLowerCase().trim().normalize('NFC')`.

Every segment is part of the key because every segment changes the answer:

| Segment | Why it scopes the answer |
|---|---|
| `qa:` | namespace |
| `v1:` | manual global-invalidation escape hatch (bump to discard all entries) |
| `{model}` | a different `LLM_MODEL` produces a different answer |
| `{temperature}` | non-zero temperature would make answers non-deterministic; the value is keyed so a config change can't serve a stale deterministic answer |
| `{promptHash}` | first 8 hex of `SHA256(QA_PROMPT_TEMPLATE)` — any prompt wording change invalidates the cache automatically |
| `{topK}` | different K retrieves a different context, hence a different answer |
| `{ingestionTimestamp}` | the Sprint A `ingestion:last_successful_run` marker; re-ingestion changes it and invalidates every entry without a manual flush |
| `{contentHash}` | the actual question + the exact retrieved chunk IDs |

Normalization (lowercase + trim + NFC) folds trivial question variants onto
one key; sorting the chunk IDs makes retrieval order irrelevant.

### 3. The prompt template is the single source of truth for `promptHash`

`QA_PROMPT_TEMPLATE` was extracted from `QaChainService` into
`qa.constants.ts`. The chain builds its `PromptTemplate` from it AND the
cache hashes it. This guarantees the `promptHash` segment tracks the prompt
that actually runs — a prompt edit can never serve an answer generated under
the old prompt.

### 4. Lookup happens AFTER retrieval, not before

The key depends on the retrieved chunk IDs, so retrieval must run first. The
rejected alternative — keying only on the question and checking the cache
*before* retrieval — is faster on a hit but unsound: if the dataset or topK
changed such that retrieval would now return different chunks, a
question-only key would serve an answer grounded in chunks that are no longer
the top matches. Paying retrieval on every request keeps the cache honest.

**Acknowledged limitation:** because retrieval always runs, a hit saves the
~2.4 s LLM call but not the ~230 ms retrieval. Net hit latency is **~250 ms,
not ~10 ms**. This is a real, documented trade-off, not an oversight.

### 5. Cached value shape

```ts
interface CachedResponse {
  answer: string;
  sources: QaSource[];   // the project's real source shape (no SourceDto exists)
  chunksCount: number;
  cachedAt: string;      // ISO timestamp, operator diagnostics
}
```

Sufficient to reconstruct the full `QaResult` (answer + sources) on a hit
without re-running anything. JSON-stringified on write, parsed on read; a
corrupt entry is deleted and treated as a miss.

### 6. TTL of 1 hour

`CACHE_TTL_SECONDS=3600`. The ingestion-timestamp segment already handles
correctness invalidation on data changes, so the TTL is only a **secondary
safety net** — it bounds memory for one-off questions that are asked once and
never refreshed, so they don't linger in Redis indefinitely. It is not the
primary invalidation mechanism.

### 7. Fail-open on every Redis error

A Redis read error → treated as a miss (normal pipeline runs). A write error
→ swallowed (the answer was already returned). This mirrors Sprint A, Sprint
Rate-Limit, and Sprint Distributed-Breaker: the cache is a latency/cost
optimisation, never a correctness primitive, so a Redis outage must degrade
to "uncached but working", never to a 500. The fail-open is enforced at two
layers — inside `QaResponseCacheService` (every method catches) and again
around the call sites in `ask()` (lookup wrapped so any fault drops to a
normal LLM call; write `.catch` guards the response).

### 8. Scope: non-streaming only

Only `QaChainService.ask()` is cached. `askStream()` is untouched. Caching a
token stream would mean either buffering the whole answer before emitting
(defeating the point of streaming) or replaying stored tokens (added
complexity for a path whose value is the live token feed). The scope
reduction is deliberate and matches the portfolio nature of the project.

## Consequences

**Positive**

- Repeat questions drop from ~2.5 s to ~250 ms and cost zero chat tokens.
- Re-ingestion invalidates the cache automatically (timestamp segment) — no
  manual flush, no stale grounded answers.
- A prompt or model/temperature/topK change invalidates automatically.
- Redis outage is invisible to users (fail-open).

**Negative / accepted**

- A hit still pays retrieval (~230 ms) — see decision 4.
- Exact-match hit rate is lower than semantic caching — accepted for
  correctness (decision 1).
- Streaming endpoint gets no cache benefit (decision 8).

**Honest hit-rate expectations** (no metrics endpoint ships this sprint, so
these are estimates to be validated in Phase 2+):

- Demo / scripted walkthrough (a fixed question set): ~60–80 %.
- Real-user organic traffic (high question variety): ~10–25 %.
- Bot / spam / repeated-query floods: ~40–60 %.

## Out of scope

- Semantic / similarity caching (correctness risk — decision 1).
- Caching the streaming endpoint (decision 8).
- Cache hit/miss **metrics endpoint** — deferred (Phase 5 / future `/metrics`).
- Per-user cache namespacing — there is no auth layer.
- Cache warming / preloading.
