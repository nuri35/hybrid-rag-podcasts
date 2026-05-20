# ADR 0003 — Vector store module separation and retrieval layer

- **Status:** Accepted
- **Date:** 2026-05-19
- **Phase:** 1.5 (VectorRetrieverService)
- **Related:** ADR 0002 (CSV → Document mapping), ADR 0006 (Chroma repository design)

---

## Context

After Phase 1.3 the project had a single `IngestionModule` that owned everything related to the vector store, including the `ChromaRepository`. Phase 1.5 (retrieval) introduces a second consumer of that repository: a `VectorRetrieverService` that converts a user query into the top-K relevant chunks. Phase 4 will add a `HybridRetrieverService` that combines vector and graph signals.

Three problems to solve:

1. **Module boundaries.** `ChromaRepository` is no longer "ingestion-only" infrastructure. Multiple modules need it as a singleton. The DI graph must reflect this without forcing retrieval to depend on the whole ingestion module.
2. **Embedding direction.** Document and query embeddings use *different* task types on the Gemini API (`RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`). One service, two task-type-bound clients.
3. **Retrieval-as-Runnable.** Phase 1.6's QA chain composes retrieval as one stage in an LCEL pipe (`retriever | format | prompt | llm`). The retriever must produce a `Runnable<string, RetrievedChunk[]>` without forcing every consumer to know the chain plumbing.

## Decision

### 1. `VectorStoreModule` is shared infrastructure

`ChromaRepository` moves to `src/modules/vector-store/` and is provided + exported by a new `VectorStoreModule`. Both `IngestionModule` and `RetrievalModule` import this module — they each get the same `ChromaRepository` singleton because NestJS deduplicates providers across `imports`. The Chroma exceptions (`ChromaUnreachableException`, `ChromaWriteFailedException`, `FailedBatch`) move alongside the repository.

`VectorStoreModule` deliberately stays thin — single provider, single export. It is the canonical place to put any future Chroma-specific infrastructure (e.g., a collection lifecycle manager, a per-tenant collection router).

### 2. `RetrievalModule` is a peer of `IngestionModule`, not a child

`RetrievalModule` imports two things:

- `VectorStoreModule` (for `ChromaRepository`)
- `IngestionModule` (which re-exports `EmbedderService`)

Importing `IngestionModule` for one provider feels coarse, but NestJS only brings in *exported* providers, not the whole DI graph — `RetrievalModule` does not see `CsvLoaderService`, `ChunkerService`, etc. The alternative — extracting `EmbedderService` into its own `EmbedderModule` — is a larger refactor with no payoff because there is no third consumer planned. We accept the asymmetry and revisit only if `EmbedderService` grows a third consumer.

### 3. `IRetriever` interface from day one

The contract is one method:

```typescript
interface IRetriever {
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievedChunk[]>;
}
```

`VectorRetrieverService` (Phase 1.5) and `HybridRetrieverService` (Phase 4) both implement it. The QA chain depends only on `IRetriever`, so swapping implementations is a one-line DI change.

### 4. Separate Gemini clients per task type

LangChain's `GoogleGenerativeAIEmbeddings` constructor accepts `taskType` once; there is no per-call override. `EmbedderService` keeps two instances:

- `embeddings` — `taskType: RETRIEVAL_DOCUMENT`, used by `embedDocuments()` during ingest.
- `queryEmbeddings` — `taskType: RETRIEVAL_QUERY`, used by `embedQuery()` during retrieval.

Both share the same API key, model, and the same token-bucket + adaptive-retry instrumentation. The token-bucket state is a single `lastRequestTime` on the service, so document and query embeddings share the same rate budget (correct — Gemini bills against a project-level quota, not a per-task-type quota).

### 5. L2 → cosine score conversion lives in `ChromaRepository`

For unit-normalized vectors, cosine similarity is recoverable from L2 distance as `1 − L2² / 2`. The conversion happens once, at the boundary where raw distances enter our code (`ChromaRepository.similaritySearch`). Downstream layers (retriever, QA, controller) treat `score ∈ [0, 1]` as opaque cosine similarity. Score is clamped to 0 on the floor (theoretical max L2 on unit vectors is √2 → score 0; practical max for semantically related embeddings is well below √2).

This decision overrides the earlier `1 − distance` formula in `ChromaRepository` (which silently assumed cosine *distance* but the actual collection uses L2). See chroma.repository.ts line ~340; the unit test asserts `distance=0.1 → score=0.995`.

### 6. LCEL Runnable factory

`VectorRetrieverService.toRunnable(options?)` returns a `RunnableLambda<string, RetrievedChunk[]>`. The retrieval options are bound at factory time so the runnable's only input is the query string — composable with the rest of the QA chain (`retriever.toRunnable() | format | prompt | llm`).

## Alternatives considered

### A. Keep `ChromaRepository` inside `IngestionModule`, re-export it from there

**Rejected.** The repository is no longer ingestion-specific. Keeping it in `IngestionModule` would make module names lie about responsibility and force every future module that needs vector access to depend on ingestion. The cost of extracting was small (`git mv` preserved history).

### B. Inline the cosine score conversion in `VectorRetrieverService`

**Rejected.** Pushes the math out of the boundary into a downstream layer, leaves `ChromaRepository`'s reported score wrong-but-unused, and creates a foot-gun for any future consumer that calls `similaritySearch` directly. Fix the score at the source.

### C. One Gemini client, override `taskType` per call

**Rejected — not possible.** LangChain's `GoogleGenerativeAIEmbeddings` bakes `taskType` into the constructor; there is no per-call API. Even if we monkey-patched, doing so would race under concurrency. Two clients is the clean answer.

### D. No `IRetriever` interface; depend on `VectorRetrieverService` directly

**Rejected.** Phase 4 hybrid retrieval is in the project plan. Introducing the interface later means the QA chain has to change too. The Liskov-friendly seam costs one type definition now.

## Consequences

### Positive

- Clear module ownership: `VectorStoreModule` owns Chroma access, `RetrievalModule` owns retrieval logic, `IngestionModule` owns the ingest pipeline. Future modules (QA in Phase 1.6, Hybrid in Phase 4) plug in without disturbing existing boundaries.
- `git mv` preserved file history on the move — `git log --follow` works for the Chroma files.
- Score is now a real cosine similarity in `[0, 1]`. Phase 1.6 prompt + Phase 1.8 evaluation can rely on the score as a meaningful signal.
- `IRetriever` interface keeps the Phase 4 hybrid retriever drop-in.
- LCEL `toRunnable()` factory lets Phase 1.6 compose the chain without touching retrieval internals.

### Negative / trade-offs

- `RetrievalModule` imports the whole `IngestionModule` for one provider. Acceptable because NestJS only injects *exported* providers, not the rest. If `EmbedderService` ever has three consumers, extract it into its own module.
- Two Gemini clients share token-bucket state. Correct for billing but means a heavy ingest run will throttle concurrent queries. Phase 1.7+ may add a separate rate budget for queries if interactive QA latency becomes a concern.
- The score formula fix changes numerical values returned by `similaritySearch` (`1 − distance` → `1 − distance²/2`). Anything that pinned the old values (golden-questions thresholds, etc.) needs to be re-validated. There were none at the time of this ADR; Phase 1.8 will set thresholds against the new formula.

## Future work

- **Phase 4 hybrid retrieval** — `HybridRetrieverService` implements the same `IRetriever`, lives in `RetrievalModule`, depends on `VectorStoreModule` + a new `GraphStoreModule` for Neo4j.
- **Query-side rate budget** — if interactive QA blocks behind ingest's token bucket, give `embedQuery` its own bucket (separate `lastRequestTime`) and split RPM allowance via env.
- **Score calibration** — Phase 1.8 evaluation may show that the `[0, 1]` raw score does not correlate cleanly with usefulness. Consider a learned calibration / reranker (Phase 2 candidate).

---

## Phase 1.5 hardening notes (post-ship, 2026-05-20)

After Phase 1.7 closed, a retrospective walk-through of Phase 1.5 surfaced four items that did not warrant new functionality but mattered for production behaviour. Each got its own focused commit (`efce868..e1cddb4`). The decisions are recorded here, not in a new ADR, because none of them change the architectural shape laid out above — they tighten the contracts that this ADR already established.

### 7. Metadata key constant + warn on fallback

`mapToRetrievedChunks` read `result.metadata['chunk_index']` with a bare string literal. A future ingestion-side rename or casing change would silently flip every chunk's `chunkIndex` to its array position with zero signal. Two changes close the gap:

- A single source of truth: `src/modules/retrieval/retrieval.constants.ts` exports `METADATA_KEYS` (`CHUNK_INDEX`, `EPISODE_ID`, `SOURCE`). Retrieval imports the constant; ingestion still writes the string directly today (intentional — separate refactor) but a drift between the two now shows up in the operational signal below.
- When the value is missing or non-numeric, a structured warn fires (`metadata_chunk_index_fallback id=… expected_key=chunk_index received_type=… using_array_idx=…`). Return value is unchanged so the happy path is identical, but the warn count is observable in log aggregators.

Chose warn-and-continue over throw because the array-index fallback already preserves *ordering* — a chunk without metadata is still placed correctly relative to its peers in the result set. Throwing would break a query for a schema mismatch that only affects a derived field consumers may not even read. The signal vs. the disruption trades correctly toward warn.

### 8. Correlation-ID wrapping for `RetrievalFailedException`

The public-facing exception used to embed the underlying error's `message` directly:

```ts
throw new RetrievalFailedException(`Retrieval failed: ${error.message}`);
```

`AllExceptionsFilter` returns that string in the HTTP response body verbatim. SDK errors typically include the upstream URL, the request payload, and sometimes a partial credential (`"API key starts with AIza_…"`). Any of those is information disclosure on a 500.

New shape:

- `RetrievalFailedException` constructor accepts `(correlationId: string, publicMessage = 'Retrieval failed')` and exposes `correlationId` as `readonly`. The public message is *only* the generic phrase plus the UUID v4 (`"Retrieval failed. Reference: <uuid>"`).
- The catch block in `retrieve()` generates the UUID via Node's `randomUUID` (no new dependency), logs `retrieve_failed_wrapped correlation_id=<id> duration_ms=… error_class=… error_message=…` server-side with the full original detail, then throws the sanitized exception.

Why a UUID rather than a sequence number / hash:

- A UUID v4 has enough entropy that on-call can paste it into a log search without colliding with anything else, even across pods.
- It does not leak request count or temporal information.
- `node:crypto.randomUUID()` is a single-line dependency-free fix.

Pass-through exceptions (`EmptyQueryException`, `QueryTooShortException`, `QueryTooLongException`, `InvalidRetrievalOptionsException`, `EmbeddingFailedException`, `ChromaUnreachableException`, `ChromaWriteFailedException`) deliberately did not gain correlation IDs — they carry either user-input messages or known-state messages that are safe to surface, and their HTTP status codes already do the right thing through `AllExceptionsFilter`. Mixing the patterns would have introduced two-different-error-shape ambiguity for no benefit.

### 9. Filter allow-list at the retrieval boundary

`retrieve()` used to forward `options.filter` directly into `ChromaRepository.similaritySearch(vec, topK, filter)` with no validation. Phase 1.5's HTTP layer (Phase 1.7) does not currently expose filter via DTO, but three forces argue for guarding the seam now:

1. Internal callers (future hybrid retriever, evaluation harness, agent layer) can pass arbitrary shapes today.
2. Phase 1.7+ may expose filter via a richer DTO — the guard should already exist when the wire surface opens.
3. A stray `where` clause from a test double silently produces empty results, which is a confusing failure mode to debug.

The decision is **allow-list, not deny-list**:

- Deny-lists rot. Every Chroma version that adds a new operator is a security update we would have to remember to mirror.
- Allow-lists fail closed. A caller that needs a new key or operator must request it explicitly, which is the right ergonomic gate.

The keys: `METADATA_KEYS` values (`chunk_index`, `episode_id`, `source`). The operators: `$eq` and `$in`. Both lists live in `retrieval.constants.ts` next to `METADATA_KEYS` so future expansion has one location to touch.

Notable rejections:

- **Top-level operators (`$or`, `$and`, `$not`)** fall through the key whitelist because they ARE top-level keys in Chroma's syntax. This is deliberate — disjunction support would let callers compose unbounded boolean queries against the collection, and that is a deliberate API change, not an accidental side effect.
- **`$ne`, `$nin`** open up enumeration-by-negation (rule out one value, see what's left); kept off the list.
- **`$gt`/`$lt`/`$gte`/`$lte`** would unlock range queries over future numeric metadata (`timestamp_start`, `duration_min`) — fine to consider when those fields are wired up at the storage layer, but premature today.

Sanitization runs **before** the embedder is called. A malformed filter rejects in O(1) without spending a Gemini call — important on a Tier 1 quota where every embed counts.

Violations throw `InvalidRetrievalOptionsException` → 400 via the existing pass-through ladder. No new exception class needed; no new exception filter wiring.

### 10. Dead-code-but-intentional listing in the catch ladder

The `instanceof` ladder in `retrieve()` lists seven exception types as pass-through candidates. Four of them (`EmptyQueryException`, `QueryTooShortException`, `QueryTooLongException`, `InvalidRetrievalOptionsException`) are thrown by `validateQuery()` and `validateAndResolveTopK()` **before** the `try` block opens, so they bubble out directly and never reach the catch. `ChromaUnreachableException` is similarly module-init-only. The check is structurally dead code today.

The decision is to **keep them listed with a comment**, not remove them. Two reasons:

- Future refactoring that moves validation inside the `try` block, or new code paths inside the `try` that legitimately throw them, would otherwise silently get re-wrapped into 500s. The forward-defensive listing costs one cheap `instanceof` per call and saves a class of subtle regressions.
- The list also documents intent — these are the exceptions the controller boundary cares about. Pruning them would lose that signal.

A multi-line comment above the ladder records exactly which entries are dead today and why they are kept, so future readers do not assume validation happens inside the `try`.

### Out of scope confirmations (explicit, for the next reader)

These items appeared in the Phase 1.5 retrospective but were deliberately deferred and remain deferred after this hardening pass:

- **Caching layer** (in-memory LRU, Redis) for repeated queries — Phase 1.7.5 audit will design caches holistically.
- **Global request-scoped correlation ID middleware** + propagation into HTTP response headers — Phase 1.7.5.
- **Default `scoreThreshold`** — Phase 2 evaluation will set the value against real golden questions.
- **Over-fetch and reranking** — Phase 2 / Phase 4 work depending on hybrid signal.
- **DTO exposure of filter** — Phase 1.7 follow-up; the sanitizer is the seam to wire it through once the DTO exists.
- **Expanded filter key set** (`guest_name`, `timestamp_start`) — requires ingestion-side changes to write those fields first.
- **`QaChainFailedException`** (Phase 1.6) — separate audit pass; its current shape stays unchanged.
- **Token bucket / rate limit logic** — out of scope explicitly.
