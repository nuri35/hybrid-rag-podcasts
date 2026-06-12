# Hybrid RAG Podcasts — Project Memory

This is the constitution for the **hybrid-rag-podcasts** project. Read first before any task. Update when phases complete or new conventions emerge.

---

## Project overview

A hybrid RAG (vector + graph) Q&A system over podcast transcripts. Built as a portfolio artifact demonstrating AI-augmented backend engineering at a senior level.

- **Functionality:** Users ask natural-language questions about podcast content; system returns grounded answers with mandatory source attribution.
- **Audience:** AI engineering recruiters evaluating combined backend + AI skills.
- **Non-goal:** Multi-tenant SaaS, user accounts, real-time updates. This is a focused engineering showcase.

---

## Tech stack

- **Backend framework:** NestJS (TypeScript, strict mode)
- **LLM orchestration:** LangChain.js + LCEL composition
- **Vector store:** Chroma (local persistence)
- **Keyword store:** Elasticsearch 8.13.0 (BM25, Phase 4) — `@elastic/elasticsearch` 8.13.x client, singleton, installed with `--legacy-peer-deps` (same chromadb peer-dep conflict as `@google/generative-ai`). Backing service in docker-compose alongside Chroma/Redis.
- **Graph store:** Neo4j (community edition or Aura — Phase 3+)
- **Embedding model:** OpenAI `text-embedding-3-small` (1536 dim)
- **Generation model:** `gpt-4o-mini` (configurable via env)
- **Schema validation:** Zod (LLM outputs) + class-validator (HTTP DTOs)
- **CLI:** nest-commander
- **Coordination / cache:** Redis via ioredis (Phase 1.7.5 Sprint A — ingestion lock, integrity marker, rate-limit counters; Sprint Cache — LLM response cache). **Client uses a 2s `commandTimeout` (`REDIS_COMMAND_TIMEOUT_MS`) — a connected-but-unresponsive Redis (hang/pause/partition) converts to a thrown error and engages the existing fail-open paths instead of blocking indefinitely (surfaced by Sprint Cache validation 2026-06-02).**
- **Rate limiting:** `@nestjs/throttler` with a custom Redis-backed storage (Phase 1.7 Sprint Rate-Limit)
- **Testing:** Jest (unit + e2e)
- **Evaluation:** ~~Ragas-equivalent metrics via LangChain.js evaluation tools~~ → **Python eval harness in `evaluation/`** (revised 2026-06-07): Ragas 0.2.6 with Gemini judge for semantic metrics + custom deterministic retrieval metrics (MRR/Hit@5/Precision@5/Recall@5) + pattern-based refusal compliance. Dev-time tooling only — same Python carve-out as `scripts/prepare_dataset.py`, never a runtime dependency. The JS evaluation ecosystem has no mature Faithfulness/Context Recall equivalents. See ADR 0017.

---

## Foundation reasoning — the 3 questions that shaped this project

Every architectural decision below traces back to answers to these three questions. When adding a new feature, ask them again for that feature.

### Q1. What is the desired functionality?

- **Input shape:** Natural-language questions about podcast content. Four query types expected: pure semantic, metadata filter, pure relational, hybrid.
- **Output shape:** Prose answer with mandatory source attribution (which episode, which guest, verbatim quote where relevant). NOT structured JSON for end users.
- **Accuracy:** Faithfulness > 0.9, context precision > 0.7, context recall > 0.8.
- **Behavior on missing info:** Refuse and say so; never hallucinate. "Bu bilgi context'te yok."

### Q2. What information is needed?

- **Domain:** Podcast transcripts (CSV format, DataCamp-style) — text, metadata, and implicit entity relationships.
- **Information types:** Semantic content, metadata filters, entity relationships, hybrid combinations.
- **→ Conclusion: Hybrid RAG (vector + graph).** Pure vector cannot answer relational queries; pure graph cannot do semantic similarity.
- **Freshness:** Static dataset. No real-time updates. One-time ingestion is sufficient.
- **Source:** Single CSV file with both structured columns (episode_id, date, guest_name, affiliation, duration) and unstructured column (transcript_text).

### Q3. How should information be structured for retrieval?

- **Vector store (Chroma):** Transcript chunks with structured columns as metadata. Serves semantic queries and metadata-filter queries.
- **Graph store (Neo4j):** Entity graph only (Episode, Person, Company nodes + relationships). NO lexical hierarchy. NO chunks. Serves pure relational and hybrid queries.
- **Bridge:** `episode_id` and `guest_name` appear in BOTH stores (Chroma metadata + Neo4j properties) to link them during hybrid retrieval.
- **Preprocessing paths:**
  - Transcript → unstructured → **clean (regex)** → chunk + embed → Chroma
  - Structured columns → metadata into Chroma + node properties into Neo4j (deterministic)
  - Transcript entities → unstructured → LLM-based extraction (Zod schema) → Neo4j

### When adding a new feature

Run these three questions for the feature before writing code. Record the answers in `docs/ADR/`. If answers contradict an existing decision below, write an ADR proposing the change and update CLAUDE.md.

---

## Architectural decisions

Each was a deliberate choice. Do not revisit without an ADR.

1. **Single NestJS service.** No Python sidecar, no upstream API gateway. LangChain.js owns all LCEL composition. A Python service would dilute the AI engineering narrative and add operational complexity for no learning gain.

2. **LCEL composition as the orchestration backbone.** All retrieval, prompting, and generation flows through `Runnable` pipes. Imperative chaining is forbidden — if you find yourself writing `await model.invoke(...)` in service code, you are doing it wrong.

3. **Hybrid retrieval = entity graph + vector store.** Not lexical graph. Chunks live ONLY in Chroma. Neo4j has Person/Company/Episode nodes and their relationships only. The bridge between stores is shared identifiers (`episode_id`, `guest_name`) duplicated in Chroma metadata and Neo4j properties.

4. **Schema-controlled extraction for graph building.** `LLMGraphTransformer` is Python-only and not available in LangChain.js. Use Zod schemas with `model.withStructuredOutput(schema)` for controlled, predictable entity/relationship extraction.

5. **CLI-based ingestion (one-time, idempotent).** No admin upload endpoint, no queue-based ingestion in initial phases. Dataset is static. Queue-based ingestion is a documented future phase, not part of the core deliverable.

6. **No NestJS API gateway in front of this service.** This service IS the API. Adding an extra NestJS layer would be cargo-culting.

7. **Data preparation script in `scripts/prepare_dataset.py` is the only Python in the project.** It runs once at clone time to download and remap the Lex Fridman dataset. Production code remains TypeScript-only per the no-Python-sidecar decision; this is a dev-time data tool, not a runtime dependency. Recommended workflow uses a virtual environment (`.venv/`, gitignored) — full prereqs and per-OS activation steps live in `README.md` "Data preparation" and `scripts/README.md`.

8. **CSV parsing uses csv-parse + Zod with skip-and-warn behavior.** A single malformed row never aborts ingestion; counts of skipped rows are logged. Chunking uses `RecursiveCharacterTextSplitter` with 800/100 default; chunk IDs are deterministic (`{episode_id}_chunk_{idx}`) for idempotent re-runs.

9. **Embedding provider is Google Gemini ~~`text-embedding-004` (768 dim)~~ → `gemini-embedding-001` (since 2026-06, via `EMBEDDING_MODEL` env; `text-embedding-004` was retired from the Generative Language API — 404 on `embedContent`, absent from ListModels as of 2026-06-05).** Dataset was re-ingested in the new vector space. The Phase 2 Ragas judge uses the same `gemini-embedding-001` model — **judge and production share the free-tier embedding quota**, so eval runs can see 429s on `answer_relevancy` while the API is also embedding queries. Parallelism is 5 in-flight batches via `p-limit`; batch failures are isolated via `Promise.allSettled`; LangChain handles per-batch retry (3 attempts). Switching provider requires re-ingestion since vector spaces differ. (`@google/generative-ai` is installed at root with `--legacy-peer-deps` because chromadb 1.x declares a stale `^0.1.1` peer dep that doesn't affect actual chromadb usage — see `package.json`.)

10. **Text cleaning is a dedicated service between CSV load and chunking.** It applies three levels of normalization: unicode/whitespace/punctuation/sentence-dedup (always), Lex Fridman intro/outro stripping (default on, anchor-phrase-based with safe no-match fallback), sponsor/filler removal (deferred to Phase 2, currently warning-log stubs). All rules are deterministic regex — no LLM involvement, idempotent, dependency-free. See ADR 0004.

11. **Chroma deployment and metric strategy.** Local Chroma server via docker-compose (named volume on Windows for performance, gitignored). Raw `chromadb` JS client (no LangChain wrapper — we supply pre-computed Gemini vectors and need direct control over `upsert`). **Distance metric uses Chroma's default L2; equivalence to cosine is achieved by normalizing all vectors to unit length at embed time** (see `EmbedderService.normalizeVector`). For unit vectors L2 distance ranking is mathematically identical to cosine similarity ranking (`cos(a,b) = 1 − L²(a,b)/2` when `||a||=||b||=1`). This is metric-agnostic, robust across Chroma versions, and matches how Sentence Transformers, OpenAI, and Pinecone recommend handling non-normalized embeddings like Gemini's. Query vectors must be normalized the same way at retrieval (Phase 1.5). The chromadb 1.10.x JS client does NOT expose the Configuration API for HNSW space; `metadata['hnsw:space']` is silently ignored, and direct POSTs to the configuration endpoint require Pydantic-internal `_type` discriminators that are not documented — we chose normalization over fragile internal-API hacking. See ADR 0006 decision 9.

12. **Idempotent ingestion via deterministic `chunk_id` + Chroma `upsert()`.** Re-running ingestion overwrites cleanly; same `{episode_id}_chunk_{idx}` ID survives. `--reset` flag wipes the collection first when a clean state is required. Failures are atomic at the operation level (per-batch retry; throw `ChromaWriteFailedException` with full diagnostics if any batch fails after retries) — partial state on disk is benign because re-runs overwrite.

13. **Configurable write concurrency mirrors Pinecone's `pool_threads` semaphore pattern.** Default `CHROMA_WRITE_CONCURRENCY=3` parallel batches via `p-limit`. Local Chroma serializes HNSW writes server-side, so concurrency yields no local speedup — but no harm either. Remote deployments (different VM, Chroma Cloud) gain 15–33 % via network overlap; tuning is a single env change, never a code change.

14. **Production readiness baked in from day one.** Health check at module init via `client.heartbeat()` wrapped in a 5 s timeout — fails fast on a dead server before any Gemini quota is spent. Per-batch HTTP timeout (default 30 s, configurable). Retry-with-backoff for transient errors (`429`, 5xx, timeouts, `ECONNRESET`): up to 3 attempts with `1s → 2s → 4s` exponential delays plus ±200 ms jitter; permanent errors (4xx auth/validation) fail fast. Structured logs prefix events (`chroma_write_complete`, `chroma_batch_retry`) for log aggregators. Graceful shutdown via `OnModuleDestroy` + `SIGINT`/`SIGTERM` handling. Chroma Cloud auth via optional `CHROMA_API_KEY` + `CHROMA_API_KEY_HEADER` (default `X-Chroma-Token`) plumbed through `fetchOptions.headers`.

15. **Two-layer rate limiting in `EmbedderService` — token bucket (proactive) + adaptive retry (reactive).** Gemini Tier 1 caps the embedding endpoint at ~15 RPM and LangChain's default 7-second exponential backoff is shorter than Gemini's 60-second reset window, so the wrapper-level retry never escapes. `EmbedderService.waitForToken()` reserves atomic per-request slots via a monotonically advancing `lastRequestTime` (slot-reservation pattern is safe under concurrency, unlike a naive read-then-write). `EmbedderService.embedWithAdaptiveRetry()` then handles stray 429s AND the `@langchain/google-genai` 0.2.x silent-empty-array substitution (`Array(N).fill([])` returned when a `batchEmbedContents` call rejects) — both routes through short exponential backoff (200 ms → 2 s cap × 1.5 growth × up to 10 attempts by default). LangChain's internal retry is disabled (`maxRetries: 0`) to centralize retry logic. Atomic-success semantics preserved: a fully exhausted batch throws → `Promise.allSettled` records rejection → `EmbeddingFailedException` aborts ingestion. Tier-aware via env (`EMBEDDING_REQUESTS_PER_MINUTE` — Tier 1=15, Tier 2=60, Tier 3=200+), code unchanged across tiers. See ADR 0006 decision 10.

16. **HTTP endpoint design — URI versioning + strict global ValidationPipe + thin controller.** `app.enableVersioning({ type: VersioningType.URI, prefix: 'api/v' })` mounts every versioned controller under `/api/v<N>/...`; URI versioning was chosen over header- or media-type-based variants because (a) it shows up in curl/docs, (b) Swagger UI generates one path entry per version automatically, (c) future Phase 4 hybrid endpoints can opt into `version: '2'` without disturbing v1 consumers. `ValidationPipe` is global with `whitelist + forbidNonWhitelisted + transform + enableImplicitConversion`; `forbidNonWhitelisted` (reject, not silently strip) is deliberate so client typos surface as 400s instead of silent data loss. `QaController` is a thin pass-through (5 lines of logic): it converts the DTO into a service call and returns the result. Errors propagate unwrapped — `AllExceptionsFilter` (Phase 1.1) maps `QaChainFailedException`/`RetrievalFailedException` (extends `InternalServerErrorException` → 500) and `EmptyQueryException`/`QueryTooShort/Long/InvalidRetrievalOptions` (extends `BadRequestException` → 400) to the right HTTP status. No try/catch in the controller — that would just re-throw, since the filter already handles formatting. See ADR 0008.

17. **Per-IP rate limiting via `@nestjs/throttler` + custom Redis-backed storage.** `RedisThrottlerStorage` (fixed-window counter: atomic Lua `INCR` + first-hit `EXPIRE`, keyed `throttle:<name>:<ip>`) replaces the library's in-memory storage so limits hold across replicas. **All Redis ops fail open** (WARN + proceed) — rate limiting is a defense layer, not a correctness primitive (mirrors Sprint A). `ProxyAwareThrottlerGuard` reads the client IP from the first `X-Forwarded-For` entry (`trust proxy` enabled in `main.ts`); registered as a global `APP_GUARD`. Two env-driven named throttlers — `default` (30/60s, question endpoint) and `stream` (5/60s, SSE). **`@nestjs/throttler` v6 applies EVERY named throttler to EVERY route by default**, so endpoints scope themselves with `@SkipThrottle({ <name>: true })`; `GET /health` bypasses both. `ThrottlerStorageRecord` times are returned in **seconds** (the guard feeds `timeToBlockExpire` into `Retry-After`, which is seconds — returning ms inflates it 1000×). See ADR 0014.

18. **Distributed circuit breaker state in Redis (`CircuitBreakerRedisStorage`).** `CircuitBreakerService` state (CLOSED/OPEN/HALF_OPEN machine, failure window, opened-at, probe lock) moved from in-process fields to five Redis keys under `circuit:llm:`, so one shared circuit federates across all instances — a trip on one is respected by all. Every multi-step transition runs as an atomic **Lua script** (no read-modify-write races); the half-open probe is gated by a `SET NX` token (exactly one probe cluster-wide; crashed holder self-heals via token TTL). Keys carry `max(windowMs, openDurationMs) × 4` TTLs so stale state self-expires. **Fail-open** on Redis errors (run unprotected, WARN `circuit_storage_failed`) — the circuit is a coordination optimisation, not a correctness primitive. Public `execute()` contract, log shapes, and `CircuitOpenException` unchanged; `getSnapshot()` is now async. `ResilientLlmService` untouched. See ADR 0015.

19. **Redis-backed exact-match LLM response cache (`QaResponseCacheService`, non-streaming only).** `ask()` consults a Redis cache before the LLM: key `qa:v1:{model}:{temperature}:{promptHash}:{topK}:{ingestionTimestamp}:SHA256(normalizedQuestion|sortedChunkIds)`. **Exact-match, never semantic** (a similar-but-different query must never serve the wrong grounded answer). Lookup runs **after retrieval** (the key needs the chunk IDs) — so a hit saves the ~2.4 s LLM call but not the ~230 ms retrieval (net ~250 ms, not ~10 ms). The `{ingestionTimestamp}` segment (Sprint A marker) auto-invalidates the whole cache on re-ingestion; `{promptHash}` (SHA-256 of the shared `QA_PROMPT_TEMPLATE` constant) auto-invalidates on any prompt edit; 1 h TTL is a secondary safety net only. Empty-retrieval fallback and output-validation rejections are **never cached**. **Fail-open** on every Redis error (degrade to a normal LLM call / silent write, WARN `qa_cache_failed`). `askStream()` is deliberately **not** cached. `qa_complete` log gains `cache=hit|miss`. See ADR 0016.

20. **Elasticsearch keyword-retrieval service (`ElasticsearchService`, Phase 4.2) returns the SAME `RetrievedChunk` type as the vector retriever.** A singleton `@elastic/elasticsearch` 8.13.x `Client` (provided via the `ELASTICSEARCH_CLIENT` DI token by a factory in `ElasticsearchModule`, `maxRetries:0`, 3 s request timeout) runs a plain `match` query on the english-analyzed `text` field — NO bool/boost/multi_match, raw user question passed through (proven in 4.1.5 smoke tests; no tuning until 4.5). `search()` maps `hits.hits` → `RetrievedChunk[]` (`id`←`_source.chunk_id`, `document`←`_source.text`, `score`←`_score`, `metadata`←`_source` minus `text`, `chunkIndex`←`_source.chunk_index` w/ array-idx fallback) so **RRF fusion (4.3) consumes the vector and keyword lists with no adapter**. ⚠️ `score` is raw **BM25** (unbounded ~12-28), NOT the vector side's cosine `[0,1]` — the two scales are incomparable by magnitude, which is why fusion must be **rank-based (RRF), never score-averaged**. **Graceful degradation is the contract:** every query-time failure (cluster down, timeout, missing index, malformed response) is caught, logged WARN, and converted to `[]` — `search()` never throws, so the hybrid path degrades to vector-only and a request never fails because the keyword side is down. `isHealthy()` (green/yellow→true) is wired into the aggregate `/health` body as `services.elasticsearch`. Empty/whitespace query short-circuits to `[]` with no ES round-trip. Service is **dormant** until pipeline wiring in 4.4. The `@elastic/elasticsearch` install needs `--legacy-peer-deps` (same pre-existing chromadb peer-dep conflict as decision 9). 4.2.5 (Redis retrieval cache) **cancelled** — YAGNI, the `qa:v1:*` answer cache already fronts the path. See ADR 0018.

21. **Hybrid fusion is rank-based RRF (`RrfFusionService`, Phase 4.3), never score-based.** Pure function `fuse(vectorHits, keywordHits, topK=5)` in `src/modules/fusion/` merges the two `RetrievedChunk[]` lists by `RRF_score = Σ 1/(RRF_K + rank)` (1-based rank per list), dedup by `id` (summed contributions = dual-list-agreement boost, e.g. the q014 rescue), output `score` = RRF score. **`RRF_K=60`** (Cormack et al. 2009) and `FUSION_OUTPUT_TOP_K=5` are code constants, NOT env vars — changing them needs 4.5 eval evidence. Deterministic tie-break (more-lists-first → ascending `id`). Either input list may be empty (ES-down path) → reduces to the other list's order rescored, no error. **Score averaging / min-max / weighted-linear were rejected** — cosine `[0,1]` and BM25 (~12-28 unbounded) scales are incomparable by magnitude (decision 20); RRF ignores magnitude entirely. Pure (no I/O/async/state, input-immutable). Dormant until 4.4. See ADR 0019.

---

## Future optimizations

Tracked here so they are not forgotten when Phase 2 evaluation establishes the baseline:

- **1.3.f Streaming embed/write overlap.** Pipe embedder output into Chroma writer via async iterators so the next batch embeds while the previous batch writes. Estimated ~30 % wall-clock saving on full-dataset ingestion. Deferred because the current batch-then-write architecture is observable and easier to reason about; revisit after Phase 2.
- **Older-format Lex intro/outro anchors.** Pre-2020 episodes use `"The following is a conversation with…"` instead of `"And now, dear friends, here's…"`. Add to `LEX_INTRO_ANCHORS` once Phase 2 eval confirms the older-format episodes are being over-retrieved on intro-like queries.
- **Sponsor segment removal (Level 2c).** Stub exists; turn on once Phase 2 eval can measure faithfulness/recall delta. Risk: high false-positive rate on guests who naturally promote their own work.
- **Filler word removal (Level 3).** Stub exists; same gating — only enable once eval can show retrieval improves.

---

## Hard constraints — never violate

### DO NOT

- Use Python for any production code. TypeScript only.
- Suggest FastAPI, LangServe, Flask, or any Python web framework.
- Write business logic in controllers — services only.
- Use `LLMGraphTransformer`; it does not exist in LangChain.js.
- Inline chain logic in route handlers — must be a service returning a `Runnable`.
- Hardcode model names, chunk sizes, DB paths, or any environment-sensitive value. Use `ConfigService`.
- Use `any` type. If a type is unknown, use `unknown` and narrow with a type guard.
- Add a NestJS gateway service in front of this app — this project IS the gateway.
- Bypass Repository pattern by injecting raw `ChromaClient` or `neo4j-driver` into a domain service.
- Mix Pinecone-style batching ("chunks of vectors") terminology with LangChain chunking ("text chunks"). They are different things; document accordingly.
- Assume the HuggingFace `nmac/lex_fridman_podcast` dataset `end` column is numeric seconds — it is a colon-delimited string (`"HH:MM:SS.mmm"` or `"MM:SS.mmm"`). Always parse via `parse_timestamp_to_seconds` in `scripts/prepare_dataset.py` before arithmetic. Earlier code did `end / 60` directly and crashed with `TypeError`.
- Assume the HuggingFace dataset's source `id` column is unique per episode — at least one collision exists (id=14 covers both an AMA and the Kyle Vogt interview). `scripts/prepare_dataset.py` disambiguates by appending `_0`, `_1`, … to every member of a collision group; downstream code can rely on `episode_id` being unique in `data/podcasts.csv`. See ADR 0002 addendum.

### DO

- Return `Runnable<Input, Output>` from retriever and chain factory methods.
- Validate every HTTP DTO with class-validator.
- Use Zod for LLM structured output schemas.
- Make ingestion idempotent — re-running must not duplicate data.
- Preserve metadata through the pipeline (loader → chunker → writer).
- Cite sources in every generated answer.
- Update phase tracking table when a phase completes.

---

## Coding conventions

- **SOLID, especially SRP and DI.** Every service has one reason to change.
- **Meaningful names, no abbreviations.** `embeddingService` not `embSvc`.
- **Small functions.** Methods over 30 lines need a split.
- **Early returns.** No nesting beyond 2 levels.
- **No magic strings/numbers.** Use enums and constants in `src/common/constants/`.
- **Custom exceptions with proper HTTP codes.** Throw domain-specific exceptions; exception filters map to HTTP responses. Never throw raw `Error` or `HttpException` directly from services.
- **Repository pattern for DBs.** `ChromaRepository` and `Neo4jRepository` wrap raw clients. Services depend on repositories.
- **One responsibility per file.** Service per file, DTO per file, controller per file.

---

## Module structure

```
src/
  modules/
    ingestion/                    # CSV → Chroma + Neo4j
      services/
        csv-loader.service.ts
        chunker.service.ts
        embedder.service.ts
        ingestion-pipeline.service.ts
      commands/
        ingest.command.ts         # nest-commander entry
      dto/
      ingestion.module.ts
    vector-store/                 # Shared Chroma infrastructure (Phase 1.5)
      chroma.repository.ts
      vector-store.module.ts
    retrieval/                    # Retrievers (Phase 1.5+)
      vector-retriever.service.ts
      graph-retriever.service.ts          # Phase 3+
      hybrid-retriever.service.ts         # Phase 4+
      retrieval.module.ts
    elasticsearch/                # BM25 keyword retrieval (Phase 4.2)
      elasticsearch.service.ts            # plain match on text → RetrievedChunk[]
      elasticsearch.module.ts             # singleton Client via ELASTICSEARCH_CLIENT token
      elasticsearch.constants.ts
      elasticsearch.types.ts              # EsRetrievalHit = RetrievedChunk (symmetry)
    fusion/                       # RRF fusion of vector + keyword lists (Phase 4.3)
      rrf-fusion.service.ts               # pure fuse() — Σ 1/(60+rank), rank-based
      rrf-fusion.constants.ts             # RRF_K=60, FUSION_OUTPUT_TOP_K=5
      fusion.module.ts
    llm/                          # Shared chat-model factory (Phase 1.6)
      llm.service.ts
      llm.module.ts
    qa/                           # QA chain + HTTP endpoint (Phase 1.6 + 1.7)
      qa-chain.service.ts         # LCEL: prompt | llm | StringOutputParser
      qa.controller.ts            # POST /api/v1/questions
      dto/
        ask-question.dto.ts
        qa-response.dto.ts
      qa.module.ts
    redis/                        # Redis facade + distributed lock (Phase 1.7.5 Sprint A)
      redis.service.ts            # ioredis wrapper (get/set/setNX/eval/pttl/…)
      distributed-lock.service.ts
      redis.module.ts
    throttler/                    # Per-IP rate limiting (Phase 1.7 Sprint Rate-Limit)
      redis-throttler.storage.ts  # Redis-backed ThrottlerStorage (fixed-window Lua counter)
      proxy-aware-throttler.guard.ts
      throttler.module.ts
  common/
    config/                       # ConfigService, env schema (Zod-validated)
    constants/                    # All magic values centralized
    exceptions/                   # Custom domain exceptions
    interceptors/                 # Response transformers
    filters/                      # Exception filters
    repositories/                 # ChromaRepository, Neo4jRepository
    health/                       # Liveness + readiness probes
  cli.ts                          # nest-commander bootstrap (CLI entry)
  main.ts                         # NestJS HTTP app bootstrap
```

---

## LCEL composition pattern

Every retriever and chain follows the **Runnable factory** pattern.

```typescript
// CORRECT — factory returns a composable Runnable
@Injectable()
export class VectorRetrieverService {
  build(options: VectorRetrievalOptions): Runnable<{ question: string }, Document[]> {
    return RunnableSequence.from([
      // composition
    ]);
  }
}

// WRONG — imperative service that breaks composability
@Injectable()
export class VectorRetrieverService {
  async retrieve(question: string): Promise<Document[]> {
    return this.chromaRepo.similaritySearch(question);
  }
}
```

Downstream code composes factories into pipelines:

```typescript
const fullChain = vectorRetriever.build({ k: 5 })
  .pipe(formatContext)
  .pipe(prompt)
  .pipe(model);
```

See the `langchain-js-lcel` skill for full guidance.

---

## Phase tracking

Current phase: **Phase 4 — Hybrid Retrieval (Vector + Elasticsearch + RRF) IN PROGRESS (started 2026-06-10).** Plan revised same day from in-process BM25 to **Elasticsearch**. Done so far: 4.1 (ES setup + 53,427-chunk index) and 4.2 (NestJS `ElasticsearchService`, dormant). **Next: 4.3 RRF fusion.** Phase 2 (Sprint Eval-RAG-Core) closed 2026-06-07 with a clean baseline at `evaluation/results/baseline-2026-06-07/`. **Sequencing change:** Phase 4 (hybrid retrieval) is being done BEFORE Phase 3 (graph layer) — the 4 zero-hit baseline questions (q006/q012/q014/q017) are a vocabulary-mismatch problem that keyword search solves directly, so it's the higher-value next step. Phase 3 (Neo4j graph) follows. **Phase 4 is redefined** from the original "vector + graph" to "vector + Elasticsearch keyword" fusion; graph-based hybrid is deferred. See `docs/phases/phase-4.md`.

| Phase | Status | Goal |
|---|---|---|
| 1. Vector layer | ✅ Done | Working vector RAG with CLI ingestion + HTTP endpoint shipped |
| &nbsp;&nbsp;1.1 Repo init | ✅ Done | NestJS + TS-strict scaffold, Zod-validated ConfigModule, HealthModule (`GET /health`), AllExceptionsFilter, nest-commander CLI, ESLint/Prettier. |
| &nbsp;&nbsp;1.2 Ingestion scaffold + data prep | ✅ Done | IngestionModule scaffold (CsvLoader/Chunker/Embedder/Pipeline); CSV→Document mapping (pageContent=transcript_text). `scripts/prepare_dataset.py` = project's sole Python. Details: ADR 0002. |
| &nbsp;&nbsp;1.3.a + 1.3.b | ✅ Done | `CsvLoaderService` (csv-parse + Zod, skip+warn); `ChunkerService` (`RecursiveCharacterTextSplitter` 800/100, deterministic `chunk_id`/`chunk_index`/`total_chunks`); `--dry-run`. Full dataset: 319 docs → 54,172 chunks. |
| &nbsp;&nbsp;1.3.c | ✅ Done | `EmbedderService` (Gemini embeddings, batch + concurrency, `Promise.allSettled`). See decision 9/15 for the two-layer rate limiting. |
| &nbsp;&nbsp;1.3.d | ✅ Done | `TextCleanerService` — 3-level regex cleaning (L1 always; L2 Lex intro/outro config-gated; L3 sponsors/fillers deferred). Idempotent, dependency-free. Details: ADR 0004. |
| &nbsp;&nbsp;1.3.e | ✅ Done | Production `ChromaRepository` (configurable concurrency/batch/retry/timeout, per-batch backoff, idempotent `upsert`, `--reset`, module-init heartbeat, graceful shutdown). End-to-end pipeline wired. Details: ADR 0006. |
| &nbsp;&nbsp;1.3.f | ⚪ Pending | Streaming embed/write overlap — deferred, see Future optimizations |
| &nbsp;&nbsp;1.5 Retrieval | ✅ Done | `VectorStoreModule` + `VectorRetrieverService implements IRetriever` (top-K + score threshold + metadata filter + LCEL `toRunnable()`; allow-list `sanitizeFilter()`; correlation-ID error wrap; cosine score `1 − L2²/2`). 27 unit tests + 4 integration (skipped). Details: ADR 0003. |
| &nbsp;&nbsp;1.6 QA chain | ✅ Done | `LlmModule` + `QaModule`/`QaChainService` (LCEL `prompt \| llm \| StringOutputParser`; retrieval outside chain for empty-context fast-path; pass-through error mapping). **LLM_MODEL = `gemini-2.5-flash-lite`** (2.0-flash 404'd for new accounts 2026-05-19; pinned, no `-latest`). Hardened across 5 sprints — post-ship (timeout race, `cleanAnswer`, 5-rule prompt), **Retry** (RetryPolicy + CircuitBreaker + ResilientLlmService), **Streaming** (SSE `POST /api/v1/questions/stream`, initiation-only resilience), **Token** (`TokenUsageService` telemetry), **Prompt-Security** (3-layer OWASP LLM01: sanitization + instruction-sandwich + output-validation). Details: ADR 0007, 0010, 0011, 0012, 0013. |
| &nbsp;&nbsp;1.7 HTTP endpoint | ✅ Done | `QaController` `POST /api/v1/questions` + class-validator DTOs, Swagger at `/api/docs`; URI versioning, global ValidationPipe (whitelist + forbidNonWhitelisted + transform), 10 KB body limit, dev-only CORS. **Rate-Limit** sprint (`@nestjs/throttler` v6 + Redis `RedisThrottlerStorage`, fail-open, named `default`/`stream` throttlers, seconds-based `Retry-After`). **Distributed-Breaker** sprint (circuit state → Redis `CircuitBreakerRedisStorage`, single-flight `SET NX` probe). 353 tests passing. Details: ADR 0008, 0014, 0015. |
| 2. Evaluation | ✅ Done (2026-06-07) | Python eval harness in `evaluation/` (dev-time only): golden dataset (25 Q), deterministic retrieval metrics (MRR/Hit@5/Precision@5/Recall@5) + Ragas 3 (Faithfulness/Answer Relevancy/Context Recall) + refusal compliance + diagnostic engine. **Clean baseline (25/25 coverage):** MRR 0.712, Hit@5 0.810, Precision@5 0.248, Recall@5 0.786, Faithfulness 0.768, Answer Relevancy 0.589 (refusal-deflated), Context Recall 0.767, Refusal 1.000 (4/4) — overall WARNING. **Operational gotchas:** `gemini-2.5-pro` judge = 1000 req/day free tier → ~one full eval/day (≈400-600 calls); verify `questions_evaluated_for_faithfulness`≈25 in `baseline.json` to catch quota-gutted runs; `SSL_CERT_FILE`-family vars auto-cleared in the Chroma fetch. **Known gap:** q006/q012/q014/q017 = Hit@5 0 (abstract terminology, vector-only limit → Phase 4). Details: ADR 0017 + `evaluation/README.md` (incl. the excerpt-artifact discovery: 200-char excerpts → false-zero Faithfulness 0.292, fixed to 0.927 with full chunk text). |
| 3. Graph layer | ⚪ Pending | Neo4j entity graph (deterministic + LLM-based extraction) — now sequenced AFTER Phase 4 |
| 4. Hybrid retrieval | 🟡 In progress (started 2026-06-10) | **Redefined: vector + Elasticsearch keyword fusion via RRF** (was "vector + graph"). Target: the 4 zero-hit baseline questions. Sub-phases 4.1 ES setup & indexing → 4.2 ES search service → 4.3 RRF fusion → 4.4 pipeline integration → 4.5 eval → 4.6 closure. Plan revised 2026-06-10 (in-process `rank_bm25` → Elasticsearch). See the Phase 4 section below + `docs/phases/phase-4.md`. |
| 5. Query routing | ⚪ Pending | LLM tool use for adaptive retrieval routing |
| 6. Queue-based ingestion | ⚪ Future | Async ingestion via queue/worker pattern (optional) |

**Update this table when a phase completes.** Add a brief note about what was shipped.

---

## Phase 4 — Hybrid Retrieval (Vector + Elasticsearch + RRF) — IN PROGRESS

### Plan revision (2026-06-10)
After 4.1.1, the tech approach was revised from an in-process BM25 library (`rank_bm25`) to **Elasticsearch**. Rationale: production-grade, stateless backing-service architecture for portfolio value and senior-level positioning; Elasticsearch sits alongside Chroma/Redis/Neo4j as a standalone service, so the "single NestJS service / no Python sidecar" decision is **fully honored** (the earlier architectural conflict is resolved, not overridden). `rank_bm25` removed from `requirements-eval.txt`. See `docs/phases/phase-4.md` for the full updated plan.

### Status
- Sprint started: 2026-06-10 (plan revised same day). **4.1.1 + 4.1.2 + 4.1.3 shipped 2026-06-11 (commit `6861c58`):** ES 8.13.0 added to docker-compose (single-node, security disabled for dev, 512 MB heap, named volume, healthy/green verified); `elasticsearch==8.13.0` Python client in `requirements-eval.txt`; `scripts/elasticsearch/mappings/podcast_chunks.json` mapping (fields match real Chroma metadata — `chunk_id`/`text`(english analyzer)/`episode_id`/`chunk_index`/`total_chunks`/`title`/`guest_name`/`guest_affiliation`/`guest_role`/`date`/`duration_min` — NOT the spec's generic `podcast_id`/`speaker`/`timestamp_*`); `scripts/elasticsearch/create-index.py` (idempotent, `--force` recreates, 8.x explicit settings/mappings kwargs). `podcast_chunks` index created + empty (0 docs). 389 Jest tests still pass.
- **4.1.4 + 4.1.5 + 4.1.6 shipped 2026-06-11 (commit `6614ccb`) — Sub-Phase 4.1 COMPLETE:** `ingest-chunks.py` (paginated Chroma→ES, 1k pages, `chunk_id`=`_id` idempotent, per-batch error tolerance, count check; integer fields coerced from Chroma's string metadata, `''`→omit to avoid `mapper_parsing_exception`; SSL_CERT_FILE-family cleared around the Chroma client). Full ingest: **53,427 chunks, 0 failed, Chroma==ES==53427, ~15 s**; idempotent re-run confirmed (count stable). `smoke-test.py` (8-check re-runnable suite) all PASS. `scripts/elasticsearch/README.md` (ops docs). **Key finding — BM25-alone ground-truth ranks for the 4 zero-hit baseline questions (the input for the RRF discussion): q006 rank #3 (top5 ✓, "Turing machine"), q017 rank #1 (top5 ✓, "constructors abstractors"), q014 rank #8 (in top10, not top5), q012 NOT in top10 ("human walking"/"machine learning" — no rare term, vector side owns it). BM25 alone strongly fixes 2/4, partially helps 1/4, misses 1/4 — exactly the fusion case.**
- **4.2 shipped 2026-06-12 (commit `d543d0e`):** `ElasticsearchModule` + `ElasticsearchService` (singleton `@elastic/elasticsearch` 8.13.1 client, plain `match` on `text`, returns `RetrievedChunk[]` symmetric with the vector side, graceful-degrade-to-`[]`, `isHealthy()` wired into `/health` as `services.elasticsearch`). See architectural decision 20. **Dormant** — nothing calls it until 4.4. +15 unit tests + 3 skipped integration (ground-truth `269_chunk_306` top-1 confirmed against live ES); full suite 389→404 passing, 0 regressions. 4.2.5 retrieval cache cancelled (YAGNI).
- **4.3 shipped 2026-06-12:** `FusionModule` + pure `RrfFusionService.fuse(vectorHits, keywordHits, topK=5)` (`src/modules/fusion/`) — rank-based RRF `Σ 1/(60+rank)`, dedup by `id`, deterministic tie-break (more-lists-first → ascending id), empty-list degradation (ES-down → vector order rescored), input-immutable. `RRF_K=60`/`FUSION_OUTPUT_TOP_K=5` constants (no env). See architectural decision 21 + ADR 0019. **Dormant** until 4.4. +11 unit tests (hand-calc exactness + q014 dual-list rescue); full suite 404→415, 0 regressions. **Next: 4.4 pipeline integration + hybrid-mode toggle (awaiting review).**
- Scope: Elasticsearch BM25 keyword search + RRF fusion with the existing vector retrieval
- Out of scope: cross-encoder reranker (future sprint), citation-accuracy metric (future), graph RAG / agentic RAG (Agentic AI phase)

### Goal
Fix the 4 failing baseline questions (q006, q012, q014, q017) by adding keyword-based retrieval that catches specific terminology missed by vector embeddings (e.g. "Turing machine", "constructors vs abstractors", "multidimensional approach").

### Expected outcome (targets, not commitments)
- Hit@5: 0.810 → 0.92+ (4 failing questions solved)
- Faithfulness: 0.768 → 0.82+ (better chunks → better answers)
- Context Recall: 0.767 → 0.85+
- No regression on currently-passing questions; end-to-end latency < 1.5 s

### Sub-phases (revised — Elasticsearch flow)
- 4.1 Elasticsearch Setup & Indexing ← next, starts at new 4.1.1 (add ES to Docker Compose)
- 4.2 Elasticsearch Search Service (NestJS `ElasticsearchModule`)
- 4.3 RRF Fusion
- 4.4 Pipeline Integration (`HybridRetrievalService`, parallel Chroma + ES)
- 4.5 Evaluation (vs `baseline-2026-06-07`)
- 4.6 Documentation and closure (ADR 0019)

### Tech decisions locked
- BM25 implementation: Elasticsearch (latest stable)
- NPM client: `@elastic/elasticsearch` (installed in 4.2.1)
- Tokenization: Elasticsearch built-in analyzers (`standard` + English stopwords); index/query analysis configured on the same field
- Index storage: Elasticsearch-managed (internal Lucene segments) — no pickle file
- Service architecture: Elasticsearch as a Docker Compose service, called by NestJS over HTTP — same backing-service pattern as Chroma/Redis; architectural decision 1 honored

---

## Glossary

- **Chunk (LangChain sense):** A text piece produced by `RecursiveCharacterTextSplitter` for embedding. Project default: 800 chars with 100 overlap.
- **Chunk (Pinecone sense):** A batch of vectors for upsert. NOT used in this project — Chroma local has no rate limits.
- **RAG DB:** Conceptual term for any retrievable store feeding LLM context. In this project: Chroma + Neo4j together.
- **Entity graph:** Person/Company/Episode nodes with semantic relationships (`WORKED_AT`, `COLLABORATED_WITH`, etc.). NOT lexical (no `Section`/`Chapter` hierarchy nodes).
- **Bridge metadata:** Fields like `episode_id` and `guest_name` that appear in both Chroma metadata and Neo4j properties to link stores during hybrid retrieval.
- **Runnable factory:** A service method that returns a `Runnable` instance for composition; never invokes it directly.
- **LCEL:** LangChain Expression Language — the `.pipe()` and `RunnableSequence`/`RunnableParallel` composition syntax.

---

## When to consult skills

- `nestjs-rag-conventions` — when scaffolding any module, controller, service, or DTO
- `langchain-js-lcel` — when writing or modifying any chain, retriever, or Runnable composition
- `chroma-vector-store` — when working with Chroma client *(to be added at end of Phase 1)*
- `ragas-evaluation` — *(skill not created; `evaluation/README.md` + ADR 0017 cover the eval harness instead)*
- `neo4j-cypher-langchain` — when working with Neo4j or Cypher generation *(to be added in Phase 3)*
- `hybrid-retrieval-strategies` — when combining retrievers *(to be added in Phase 4)*
- `langchain-tool-use` — when implementing query routing *(to be added in Phase 5)*

---

## References

- Architecture decision records: `docs/ADR/`
- Phase plans and progress: `docs/phases/`
- Auto-generated API docs (Swagger): `/api/docs` when app is running
- Skills: `.claude/skills/`

---

## Self-update protocol — Claude maintains this file

**Claude must update CLAUDE.md automatically when any of the triggers below occur during a task.** Do not wait for user permission — update inline and inform the user briefly at the end of the response.

### Update triggers (when to edit CLAUDE.md)

1. **Phase status change** — A phase moves from `⚪ Pending` to `🟡 In progress` to `✅ Complete`. Update the Phase tracking table.
2. **New architectural decision** — Any design choice that future work must respect. Append to "Architectural decisions" with a one-line reasoning.
3. **New hard constraint** — A new DO or DO NOT rule emerges from work (e.g., "discovered library X doesn't support Y, never attempt it again"). Append to "Hard constraints".
4. **New convention** — A coding pattern that should be enforced project-wide. Append to "Coding conventions" or the relevant module section.
5. **Tech stack change** — A library added, replaced, or removed. Update "Tech stack".
6. **Module structure change** — A new module added, an existing one restructured. Update "Module structure".
7. **New skill created** — A new `.claude/skills/<name>/SKILL.md` added. Add it to "When to consult skills" with its trigger description.
8. **New glossary term** — A term used repeatedly in the codebase that risks ambiguity. Append to "Glossary".
9. **New foundation answer** — If a feature triggered a new run of the 3 questions and answers diverge from existing ones, document the divergence in "Foundation reasoning" or create an ADR.

### What NOT to put in CLAUDE.md

- Implementation details (those belong in code comments or ADRs)
- Temporary notes ("we are debugging X right now")
- Personal preferences (those go in skills or `.claude/settings.json`)
- Long code examples (keep CLAUDE.md skimmable — link to skills or docs)

### Update style

- **Append, do not rewrite.** Existing decisions stay unless explicitly revised.
- **Mark revisions clearly.** If a decision changes, strike through old text and add new with a date.
- **Keep entries terse.** One to three sentences per entry. Detail goes in ADRs or skills.
- **Tell the user.** End the response with a short note: "Updated CLAUDE.md: added X under Y section."

### Update example

If during Phase 1 we discover that Chroma's JS client has a specific quirk (e.g., metadata field name restrictions), Claude should:

1. Add to "Hard constraints / DO NOT":
   > Do not use field names containing `.` or `$` in Chroma metadata — client silently drops them.
2. Tell the user:
   > Updated CLAUDE.md: added a Chroma metadata constraint based on what we hit.

This protocol keeps CLAUDE.md as a living document without requiring the user to maintain it manually.