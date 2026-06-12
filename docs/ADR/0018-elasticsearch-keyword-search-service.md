# ADR 0018 — Elasticsearch keyword-search service

- **Status:** Accepted
- **Date:** 2026-06-12
- **Phase:** 4 — Hybrid Retrieval, Sub-Phase 4.2
- **Related:** ADR 0003 (vector retrieval — the `RetrievedChunk` type this service reuses), ADR 0006 (Chroma — the source of truth ES is derived from), ADR 0016 (LLM response cache — the reason 4.2.5 retrieval cache was cancelled)

---

## Context

Phase 4 adds a BM25 keyword retriever to complement the vector side: the 4
zero-hit baseline questions (q006/q012/q014/q017) fail because embeddings miss
distinctive terminology ("Turing machine", "constructors vs abstractors").
Sub-Phase 4.1 stood up Elasticsearch 8.13.0 and indexed all 53,427 chunks; 4.1.5
smoke tests confirmed a plain `match` query already ranks the ground-truth chunk
#1–#3 for two of the four questions.

This ADR settles how that index becomes callable from NestJS: client lifecycle,
query shape, result type, failure policy, and health integration. The service is
built but **dormant** — pipeline wiring (fusion) is 4.4.

## Decision

### 1. Singleton client behind a DI token

One `@elastic/elasticsearch` 8.13.x `Client` for the app lifetime (internal
connection pooling; never per-request), provided by a factory in
`ElasticsearchModule` under the `ELASTICSEARCH_CLIENT` token. The token
indirection is what lets unit tests inject a mock. `maxRetries: 0` — the service
owns the failure policy; hidden client retries would only inflate latency before
degradation. URL is env-driven (`ELASTICSEARCH_URL`, default
`http://localhost:9200` — the same var the dev-time Python scripts use). Client
major.minor must match the cluster (8.13.x); installed with `--legacy-peer-deps`
(pre-existing chromadb peer-dep conflict, see CLAUDE.md decision 9).

### 2. Plain `match`, no tuning

`{ match: { text: query } }` on the english-analyzed field, raw user question
passed through. NO bool/boost/multi_match — the analyzer + raw question were
proven sufficient in 4.1.5, and any tuning is deferred to 4.5 evaluation so we
change one variable at a time.

### 3. Result type IS `RetrievedChunk` (symmetry over adapters)

`search()` returns the vector side's `RetrievedChunk` type exactly, so RRF
fusion (4.3) merges the two lists with no adapter layer. Mapping:
`id`←`_source.chunk_id`, `document`←`_source.text`, `score`←`_score`,
`metadata`←`_source` minus `text` (reproduces the Chroma metadata key set),
`chunkIndex`←`_source.chunk_index` (array-index fallback + warn mirrors the
vector drift guard). The bridge key `chunk_id` is identical across both stores,
so the same chunk from either side collapses to one fused entry.

**Caveat the fusion layer must respect:** `score` here is raw **BM25**
(unbounded, ~12–28 in practice), not the vector side's cosine `[0, 1]`. The two
scales are incomparable by magnitude — which is precisely why fusion is
**rank-based (RRF), never score-averaged**.

### 4. Graceful degradation is the contract

Every query-time failure (cluster down, timeout, missing index, malformed
response) is caught, logged at WARN (`es_search_failed`, query **length** not
text), and converted to an EMPTY array. `search()` never throws. The hybrid
pipeline then degrades to vector-only — a request must never fail because the
keyword side is unavailable. Empty/whitespace query short-circuits to `[]` with
no ES round-trip. 3 s per-call request timeout converts a stalled cluster into a
fast failure.

### 5. Health wired into the existing aggregate probe

`isHealthy()` (`green`/`yellow` → true; `yellow` is normal for a single-node,
0-replica dev cluster) is injected into the custom `HealthService` and surfaces
as `services.elasticsearch` in the `/health` body — same pattern as Redis. A
`down` here signals the hybrid path will degrade to vector-only, not that the app
is unhealthy (status stays `ok`).

### 6. 4.2.5 (Redis retrieval cache) cancelled

YAGNI: the answer-level cache (`qa:v1:*`, ADR 0016) already fronts the whole QA
path, ES queries are ~10–50 ms, and the corpus is static. A separate retrieval
cache adds invalidation surface for no measurable win.

## Consequences

- **Positive:** fusion (4.3) is a pure rank-merge with zero type-translation;
  the keyword side can never take the request down; health is observable.
- **Negative / accepted:** the service is dead code until 4.4 (deliberate,
  testable in isolation first). BM25 score is not normalized — documented as a
  hard constraint on the fusion design.
- **Tested:** 15 unit tests (mocked client: mapping, topK passthrough, empty
  query, three degradation paths, `isHealthy` states) + 3 skip-by-default
  integration tests against live ES (ground-truth `269_chunk_306` top-1
  regression guard). Full suite 389→404 passing, 0 regressions.
