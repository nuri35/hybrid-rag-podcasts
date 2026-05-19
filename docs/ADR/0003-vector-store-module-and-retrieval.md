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
