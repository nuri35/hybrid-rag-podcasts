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

22. **Hybrid retrieval is the live path via a single toggle seam (`HybridRetrievalService` + `RETRIEVER` token, Phase 4.4).** `HybridRetrievalService` (`src/modules/retrieval/`, implements `IRetriever`) is a THIN orchestrator: `Promise.allSettled([vector.retrieve(q,{topK:SOURCE_TOP_K}), es.search(q,SOURCE_TOP_K)])` (defense-in-depth ON TOP of each service's own catch) → `RrfFusionService.fuse(vec, es, topK)` → return. `SOURCE_TOP_K=10` per source, fusion outputs 5. **Symmetric degradation:** a rejected side → `[]` + warn; vector-down survives keyword-only, ES-down survives vector-only, both-down → `[]` (QA empty-retrieval fallback). **Toggle = ONE seam:** `HYBRID_RETRIEVAL_ENABLED` (env, default true) drives the `selectRetriever` factory in `QaModule` that binds the `RETRIEVER` token to either `HybridRetrievalService` or `VectorRetrieverService`; `QaChainService` injects the token (`IRetriever`), so the call site is unchanged and there are NO scattered ifs. False → byte-identical Phase 2 vector path. **Env bool uses enum+transform** (`z.coerce.boolean()` maps the string `"false"`→`true`, a footgun — never use it for a toggle). Log line `hybrid_retrieval ... overlap=N degraded=none|vector|es|both` (overlap = id-intersection of the two lists = the agreement health signal; the 4 zero-hit questions show overlap=0 — vector & keyword find disjoint chunks). **Smoke finding (4.4.5):** hybrid now RETRIEVES the ES-only ground-truth chunks vector missed (q017 `269_chunk_306` via ES rank #1), but with `overlap=0` + `FUSION_OUTPUT_TOP_K=5` each side only contributes its top ~2-3, so an ES rank-#3 ground-truth (q006 `269_chunk_305`) is squeezed out, and q017 still refuses (got 306, not 307) — a 4.5 tuning vs generation question, NOT a 4.4 defect. Downstream (prompt/LLM/validation) untouched. See ADR 0019.

23. **Post-fusion neighbor-chunk expansion completes boundary-split answers (`NeighborExpansionService`, Phase 4 enhancement).** The q017 investigation proved a failure mode no fusion knob can fix: the answer-completing chunk `269_chunk_307` is in NEITHER source's top-10 (no literal query terms → BM25 skips it; vector locked onto the C++ "constructor" homonym → never surfaces ep 269), and `306` alone ends mid-sentence ("…a set of axioms |"). Raising `FUSION_OUTPUT_TOP_K`/`SOURCE_TOP_K`/`RRF_K` only reorders lists that already contain the chunk — useless here. **Fix:** after `fuse()`, `HybridRetrievalService` calls `NeighborExpansionService.expand(fused)` (`src/modules/retrieval/`), which pulls each fused chunk's **±1 neighbors** by deterministic id and places them **adjacent to the parent in `chunk_index` order**, reassembling the split sentence (306→307 contiguous). **One batched `ChromaRepository.getByIds()`** (new method) fetches only the missing neighbor ids; non-existent ids (episode boundaries) are silently skipped. id parsing is **right-anchored** (`/^(.+)_chunk_(\d+)$/`) so underscore-bearing/`_0`-disambiguated episode ids parse and neighbors never cross `episode_id`. Ordering: per-parent group `[prev?,parent,next?]`, concatenated in fusion-rank order, dedup first-wins, capped `MAX_EXPANDED_CHUNKS=12` (truncate from end). Injected neighbors get **score=0 sentinel** (context, not ranked; `formatContext` orders by position so it's inert). **Toggle:** `NEIGHBOR_EXPANSION_ENABLED` (env enum+transform bool, default true; false → fused top-K passes through byte-identical for A/B eval). Chroma fetch error → degrade to un-expanded list (WARN `neighbor_fetch_failed`). Log line gains `expanded= chunks_before= chunks_after= neighbors_added=`. `NEIGHBOR_WINDOW`/`MAX_EXPANDED_CHUNKS` are code constants (4.5-eval-gated). Smoke test deferred to a separate follow-up. See ADR 0019 (Neighbor-Chunk Expansion section).

24. **Single-shot LLM tool routing (`ToolRouterService`, Phase 5.3).** Binds the two Phase 5.2 tools to Gemini with **AUTO** tool-choice; `route()` invokes the bound model once, executes the chosen tool(s), then invokes the **UNBOUND** model (`createChatModel()`) for the final text answer — a second tool round is **structurally impossible**, so it is single-shot, **not agentic, no serial loop**. **Flat binding-safe schemas** (`top_k`/`limit` as plain `z.number()`): the strict `.int().positive()` emits JSON-Schema `exclusiveMinimum`, which Gemini's `FunctionDeclaration` subset **rejects with a 400** (verified live); the binding schema is isolated and additive — the **strict Phase 5.2 schemas stay strict** inside each tool's `execute()` (the real trust boundary). **Parallel-but-one-round:** multiple `tool_calls` run via `Promise.allSettled` (one tool's failure never loses a sibling's success), each yielding exactly one `ToolMessage` (Gemini requires one response per `tool_call` id). **Fail-loud / fail-open asymmetry:** `InvalidToolInputException` (bad LLM args) → controlled-error `ToolMessage` (graceful, model answers honestly); `MetadataQueryFailedException` / any other infra error → **rethrow** (propagates, no final invoke) — never silently dressed up as a result. **Count-all tolerance** lives in the `query_metadata` adapter (`applyCountAllTolerance` drops an orphan `field` on a value-less `count`), NOT the strict schema/service. Dispatch via a `Map<toolName, tool>` keyed by the locked name constants. Reuses `LlmService` (no new client); lives in `ToolsModule` (no `QaModule` import → no cycle). **Not yet wired into the QA pipeline (5.4); routing accuracy is measured in 5.5.** See ADR 0020.

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

- **Enable `TOOL_USE_ENABLED` in production until tool-use-path resilience is added.** Phase 5.4 deliberately DEFERRED retry / timeout / circuit-breaker + token telemetry around `ToolRouterService`'s two Gemini invokes (YAGNI — `ask()` already implements and demonstrates the full `ResilientLlmService` pattern; duplicating it for the router wasn't warranted here). The direct (`ask`) path stays fully protected; the tool-use path's two invokes are **unprotected by design**. Resilience is REQUIRED before flipping the flag on in prod, and is planned for the agentic phase where multi-step loops make it essential. Default `false` keeps prod traffic off the unprotected path. See PHASE_5_4_PLAN.md "Resilience deferral".
- **Expect `qa-facade.integration.spec.ts` to pass un-skipped by flipping `TOOL_USE_ENABLED` via `process.env` in `beforeAll`.** `ConfigModule.forRoot({ cache: true })` snapshots env **once at process startup**, so runtime mutation is NOT honored — un-skipped as-is, the two `TOOL_USE_ENABLED=true` blocks report `path:'direct'` (~2 failures). This is a **TEST-HARNESS limitation, not a product defect**: a shell-set flag (`TOOL_USE_ENABLED=true`) confirms the tool-use path routes, returns `sources:[]`/`toolUsed`/`319`, and the context-aware citation relaxation returns **200** for a long uncited metadata answer. To run the tool-use blocks cleanly, set the env var in the shell **before** jest starts (and/or split the ON/OFF blocks into separate processes). Pre-flight (all 6 Phase-5 live specs) confirmed 20/20 in-scope assertions pass and all three 5.4 critical behaviors hold. See PHASE_5_4_PLAN.md "Known test-harness limitation".
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
      hybrid-retrieval.service.ts         # Phase 4.4 — parallel vector+ES → RRF → neighbor-expand
      hybrid-retrieval.constants.ts       # SOURCE_TOP_K=10
      neighbor-expansion.service.ts       # Phase 4 enh — ±1 adjacency context completion (q017)
      retrieval.constants.ts              # RETRIEVER token + NEIGHBOR_WINDOW=1 / MAX_EXPANDED_CHUNKS=12
      graph-retriever.service.ts          # Phase 3+
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
    metadata/                     # Episode-grained exact aggregations (Phase 5.1)
      metadata-query.service.ts           # aggregate() → exact ES aggs over podcast_episodes (fail-loud)
      metadata.types.ts                   # discriminated MetadataQueryRequest/Result union
      metadata.constants.ts               # METADATA_INDEX, keyword/numeric allow-lists, caps
      metadata.module.ts                  # imports ElasticsearchModule (shares ELASTICSEARCH_CLIENT)
      exceptions/                         # InvalidMetadataQuery (400) / MetadataQueryFailed (500)
    tools/                        # LLM tool layer + routing (Phase 5.2–5.3)
      search-content.tool.ts              # wraps hybrid retrieval → { passages, context }
      query-metadata.tool.ts              # wraps MetadataQueryService → { result, summary } (+ count-all tolerance)
      search-content.schema.ts            # strict runtime input schemas (the trust boundary)
      query-metadata.schema.ts
      search-content.binding-schema.ts    # Gemini binding-safe schemas (no exclusiveMinimum) — Phase 5.3.1
      query-metadata.binding-schema.ts
      tool-factory.ts                     # tool() wrappers + buildRoutingTools/bindRoutingTools (5.3.1)
      tool-router.service.ts              # single-shot AUTO routing, parallel, fallback, logging (5.3.2–5.3.5)
      tools.constants.ts                  # tool names/descriptions + ROUTER_SYSTEM_PROMPT + controlled-error text
      tools.types.ts                      # SearchContentResult / QueryMetadataResult / RouteResult
      tools.module.ts                     # imports RetrievalModule + MetadataModule + LlmModule (NOT QaModule → no cycle)
      exceptions/                         # InvalidToolInputException (400)
    llm/                          # Shared chat-model factory (Phase 1.6)
      llm.service.ts                      # createChatModel() + createToolCallingModel() (5.3.1 typed bindTools handle)
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

Current phase: **Phase 4 — Hybrid Retrieval (Vector + Elasticsearch + RRF + ±1 neighbor expansion) ✅ COMPLETE (closed 2026-06-14).** Final clean eval `evaluation/results/baseline-hybrid-final-2026-06-14/`: **Hit@5 0.810→0.905, MRR 0.712→0.774, Context Recall 0.767→0.900, Recall@5 0.786→0.841, substantive Faithfulness ~0.841→0.905, Refusal 1.000, 0 regressions.** q014/q017 fixed; q006 (coverage gap) + q012 (vector-embedding limitation) are deliberate documented misses (ADR 0019, "Intentionally out of scope"). No reranker (deferred). **Phase 4 was sequenced BEFORE Phase 3** (the 4 zero-hit questions were a vocabulary-mismatch problem keyword search solves directly) and **redefined** from the original "vector + graph" to "vector + Elasticsearch keyword" fusion. Authoritative record: ADR 0019 + `evaluation/README.md` + `docs/phases/phase-4.md`.

**Phase 5 — Query Routing (LLM tool use) ✅ COMPLETE (closed 2026-06-26).** Single-shot tool routing (`search_content` vs `query_metadata`, both, or none; unbound final answer — not agentic) behind `TOOL_USE_ENABLED` (default false → byte-identical Phase-4 direct path). Live routing eval (33 labeled Q, real Gemini, `evaluation/results/routing-2026-06-26/`): **routing accuracy 97% (32/33)**, **100% on 6 of 7 categories**. ADR 0020 (5.3 routing) + ADR 0021 (5.4 wiring + context-aware validation + 5.5 eval). **Next: Phase 3 — Neo4j entity graph** (the remaining pending phase).

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
| 4. Hybrid retrieval | ✅ Done (closed 2026-06-14) | **Vector + Elasticsearch keyword fusion via RRF + ±1 neighbor expansion** (redefined from "vector + graph"). Final clean eval: **Hit@5 0.810→0.905, MRR 0.712→0.774, Context Recall 0.767→0.900, substantive Faithfulness ~0.841→0.905; q014/q017 fixed, q006/q012 documented out-of-scope misses, 0 regressions.** Sub-phases 4.1 ES setup → 4.2 ES service → 4.3 RRF → 4.4 integration → 4.4-E neighbor expansion → 4.5 eval → 4.6 docs/closure all done. Post-eval fixes: citation regex `601c32d`, eval methodology `bc8135b`. Details: ADR 0019, decisions 20–23, `docs/phases/phase-4.md`. |
| 5. Query routing | ✅ Done (closed 2026-06-26) | LLM tool use for adaptive retrieval routing. **5.1 metadata aggregation engine ✅** (`MetadataQueryService` + episode-grained `podcast_episodes` index, fail-loud). **5.2 tool defs ✅** (`search_content` + `query_metadata`, flat binding schemas, locked descriptions). **5.3 routing ✅ (closed 2026-06-23, ADR 0020)** — `ToolRouterService`: single-shot (UNBOUND final invoke, not agentic), AUTO tool-choice, binding-safe schemas (`exclusiveMinimum` 400 finding), parallel-but-one-round (`allSettled`), fail-loud/fail-open fallback, count-all adapter tolerance; tested in isolation (537 passed/44 skipped). **5.4 QA-pipeline wiring ✅ (closed 2026-06-23)** — QA-side `QaFacadeService` (C3): controller calls only the facade, which picks direct `ask()` vs `ToolRouterService.route()` behind `TOOL_USE_ENABLED` (default false; `QaModule` imports `ToolsModule`, acyclic). Shared cross-cutting guards extracted to one implementation each (sanitization + output-validation already services; integrity-check → `assertDataIntegrity()`, ingestion-lock → `assertIngestionNotInProgress()` on `QaChainService`, state/ownership unchanged — read-only seams), called by `ask()`, `askStream()`, and the facade's tool-use branch (lock → integrity → sanitize → route → output-validation, same order as `ask()`; no double-processing — direct path's guards stay inside `ask()`). **Context-aware output validation:** `validate(answer, corr, kind: AnswerKind)` — `DIRECT` keeps strict `[Source N]`; tool kinds relax citation; universal fail-loud floor (empty/leakage) on every kind (fixes metadata-answer 500s without swallowing real failures). Unified `AnswerResponseDto` (superset: `+toolUsed?/latency?/path`). 557 passed/46 skipped, 0 regressions, Phase 4 behavior byte-identical. **Tool-use-path resilience (retry/timeout/circuit + token telemetry around the router's two invokes) DELIBERATELY DEFERRED** — see Hard constraints. **5.5 routing-accuracy eval ✅ (2026-06-26)** — live run (33 labeled Q, real Gemini; `evaluation/run_routing_eval.py` + `evaluation/tool-routing-dataset.json`; artifact `evaluation/results/routing-2026-06-26/`): **routing accuracy 97% (32/33)**, per-category **100% on 6 of 7** (content/count/filter/aggregate/parallel/no_tool), scope_honesty 4/5 (one out-of-scope "affiliation" question routed to `search_content`). **5.6 docs closure ✅** (README + ADR 0021 + this table). Known limitations a–f: see "Phase 5 — closure" note below. Details: ADR 0020 + ADR 0021. |
| 6. Queue-based ingestion | ⚪ Future | Async ingestion via queue/worker pattern (optional) |

**Update this table when a phase completes.** Add a brief note about what was shipped.

---

## Phase 5 — Query Routing (LLM tool use) — closure (2026-06-26)

Closed after the live routing eval. Authoritative record: ADR 0020 (5.3 routing mechanics) + ADR 0021 (5.4 pipeline integration / context-aware validation / 5.5 eval). Recorded eval artifact (do not move/duplicate): **`evaluation/results/routing-2026-06-26/`** (`routing-eval.md` + `.json`). Result: **routing accuracy 97% (32/33)**, **100% on 6 of 7 categories**, scope_honesty 4/5.

**Known limitations / deliberate deferrals (a–f):**
- **a. Router resilience deferred.** No retry/timeout/circuit-breaker + token telemetry around `ToolRouterService`'s two Gemini invokes. *Why:* `ask()` already implements and demonstrates the full `ResilientLlmService` pattern; duplicating it wasn't warranted yet. **REQUIRED before enabling `TOOL_USE_ENABLED` in production**; planned for the agentic phase (multi-step loops make it essential). Also in Hard constraints / DO NOT.
- **b. r029 scope-leak (accepted, not fixed).** Out-of-scope "affiliation"-type questions can route to `search_content` and surface soft transcript detail (the model still disclaims it can't confirm a current affiliation). *Why accepted:* it's a single eval miss and the answer self-qualifies; a candidate 5.3.3 `ROUTER_SYSTEM_PROMPT` tightening ("out-of-scope fields → refuse, don't search") if revisited.
- **c. Honesty-scorer measurement artifact.** `routing_metric.honesty_pass` reuses Phase-4 `refusal_metric` patterns tuned for direct-RAG phrasing ("the sources do not contain…"); the tool-use path refuses in different words ("I cannot tell you", "I don't have that information") not covered by those patterns, so honesty read **0/4 despite the model refusing honestly (~3/4 in reality)**. Known measurement limitation, left as-is (broadening the patterns is a future tweak, not a routing fix).
- **d. Content/retrieval coverage gaps are not routing faults.** r001 (Cronin "biology ≠ Turing machine" — the known Phase-4 `269_chunk_305` coverage gap), r022 (longest-episode content drifts off-target), r033 (max tool returns duration+title but the model didn't surface the guest name) are generation/retrieval observations — pre-existing Phase-4 retrieval limits, routing was correct.
- **e. `qa-facade.integration.spec` test-harness limitation.** `ConfigModule.forRoot({ cache: true })` snapshots env once at startup, so per-block `process.env` mutation isn't honored → ~2 failures if the `TOOL_USE_ENABLED=true` blocks are un-skipped as-is. **Product is verified correct** via a shell-set flag (see Hard constraints / DO NOT). Run the ON blocks in a separate process with the env set before jest starts.
- **f. By-design omissions.** The tool-use path has **NO pipeline response cache** (the `qa:v1:*` answer cache fronts the direct path only — ADR 0016) and the **streaming endpoint has NO tool-use** (`askStream()` stays direct — ADR 0011); both are deliberate, not gaps to fill.

---

## Phase 4 — Hybrid Retrieval (Vector + Elasticsearch + RRF) — IN PROGRESS

### Plan revision (2026-06-10)
After 4.1.1, the tech approach was revised from an in-process BM25 library (`rank_bm25`) to **Elasticsearch**. Rationale: production-grade, stateless backing-service architecture for portfolio value and senior-level positioning; Elasticsearch sits alongside Chroma/Redis/Neo4j as a standalone service, so the "single NestJS service / no Python sidecar" decision is **fully honored** (the earlier architectural conflict is resolved, not overridden). `rank_bm25` removed from `requirements-eval.txt`. See `docs/phases/phase-4.md` for the full updated plan.

### Status
- Sprint started: 2026-06-10 (plan revised same day). **4.1.1 + 4.1.2 + 4.1.3 shipped 2026-06-11 (commit `6861c58`):** ES 8.13.0 added to docker-compose (single-node, security disabled for dev, 512 MB heap, named volume, healthy/green verified); `elasticsearch==8.13.0` Python client in `requirements-eval.txt`; `scripts/elasticsearch/mappings/podcast_chunks.json` mapping (fields match real Chroma metadata — `chunk_id`/`text`(english analyzer)/`episode_id`/`chunk_index`/`total_chunks`/`title`/`guest_name`/`guest_affiliation`/`guest_role`/`date`/`duration_min` — NOT the spec's generic `podcast_id`/`speaker`/`timestamp_*`); `scripts/elasticsearch/create-index.py` (idempotent, `--force` recreates, 8.x explicit settings/mappings kwargs). `podcast_chunks` index created + empty (0 docs). 389 Jest tests still pass.
- **4.1.4 + 4.1.5 + 4.1.6 shipped 2026-06-11 (commit `6614ccb`) — Sub-Phase 4.1 COMPLETE:** `ingest-chunks.py` (paginated Chroma→ES, 1k pages, `chunk_id`=`_id` idempotent, per-batch error tolerance, count check; integer fields coerced from Chroma's string metadata, `''`→omit to avoid `mapper_parsing_exception`; SSL_CERT_FILE-family cleared around the Chroma client). Full ingest: **53,427 chunks, 0 failed, Chroma==ES==53427, ~15 s**; idempotent re-run confirmed (count stable). `smoke-test.py` (8-check re-runnable suite) all PASS. `scripts/elasticsearch/README.md` (ops docs). **Key finding — BM25-alone ground-truth ranks for the 4 zero-hit baseline questions (the input for the RRF discussion): q006 rank #3 (top5 ✓, "Turing machine"), q017 rank #1 (top5 ✓, "constructors abstractors"), q014 rank #8 (in top10, not top5), q012 NOT in top10 ("human walking"/"machine learning" — no rare term, vector side owns it). BM25 alone strongly fixes 2/4, partially helps 1/4, misses 1/4 — exactly the fusion case.**
- **4.2 shipped 2026-06-12 (commit `d543d0e`):** `ElasticsearchModule` + `ElasticsearchService` (singleton `@elastic/elasticsearch` 8.13.1 client, plain `match` on `text`, returns `RetrievedChunk[]` symmetric with the vector side, graceful-degrade-to-`[]`, `isHealthy()` wired into `/health` as `services.elasticsearch`). See architectural decision 20. **Dormant** — nothing calls it until 4.4. +15 unit tests + 3 skipped integration (ground-truth `269_chunk_306` top-1 confirmed against live ES); full suite 389→404 passing, 0 regressions. 4.2.5 retrieval cache cancelled (YAGNI).
- **4.3 shipped 2026-06-12:** `FusionModule` + pure `RrfFusionService.fuse(vectorHits, keywordHits, topK=5)` (`src/modules/fusion/`) — rank-based RRF `Σ 1/(60+rank)`, dedup by `id`, deterministic tie-break (more-lists-first → ascending id), empty-list degradation (ES-down → vector order rescored), input-immutable. `RRF_K=60`/`FUSION_OUTPUT_TOP_K=5` constants (no env). See architectural decision 21 + ADR 0019. **Dormant** until 4.4. +11 unit tests (hand-calc exactness + q014 dual-list rescue); full suite 404→415, 0 regressions.
- **4.4 shipped 2026-06-12 (commit `31c5d8e`) — hybrid is now the LIVE retrieval path:** `HybridRetrievalService` (parallel vector+ES via `allSettled`, RRF fusion, symmetric degradation) wired into `QaChainService` behind the `RETRIEVER` token; `HYBRID_RETRIEVAL_ENABLED` toggle (default on, one `selectRetriever` factory seam). `hybrid_retrieval` structured logging (overlap, per-stage ms, degraded). See architectural decision 22. +9 unit tests; full suite 415→424, 0 regressions. **E2E smoke (honest):** toggle verified (off→pure vector, no ES; on→hybrid). Hybrid RETRIEVES the ES-only ground-truth vector missed (q017 `269_chunk_306`, overlap=0), but **q017/q006 answers did NOT flip to answered** — q017 lacks `307` in the fused top-5; q006's `305` (ES #3) squeezed out by overlap=0 + topK=5. q002 regression OK (`59_chunk_12`), q010 still refuses. **Next: 4.5 formal eval — does the top-5 squeeze need topK/k tuning, or is it generation-side? (awaiting review).**
- **Neighbor-chunk expansion shipped (Phase 4 enhancement, post-4.4) — addresses the q017 root cause:** the q017 investigation (read-only) proved hybrid RETRIEVES `269_chunk_306` but the LLM still refuses because the answer-completing chunk `269_chunk_307` is in NEITHER source's top-10 (no literal terms for BM25; vector locked on the C++ "constructor" homonym) — unrecoverable by any topK/RRF_K tuning. `NeighborExpansionService` now runs AFTER fusion inside `HybridRetrievalService`: pulls each fused chunk's ±1 neighbors via one batched `ChromaRepository.getByIds()`, glues them adjacent in `chunk_index` order (306→307 contiguous), dedup, cap 12; `NEIGHBOR_EXPANSION_ENABLED` toggle (default on, A/B seam); score=0 sentinel for neighbors; graceful Chroma-error degrade. See architectural decision 23 + ADR 0019 (Neighbor-Chunk Expansion). +12 unit tests + 2 wiring tests, full suite 424→438, 0 regressions, build clean. **Smoke test deferred to a separate follow-up prompt** (NOT yet run end-to-end against the live LLM). Smoke later confirmed: q017 + q014 flip to answered; q006/q012 still miss GT; q002/q010 no regression.
- **4.5 formal eval DONE (2026-06-13) — `evaluation/results/baseline-hybrid-2026-06-13/`** (single run, hybrid+expansion ON vs `baseline-2026-06-07`). **Nuanced result — retrieval REACH up, rank metrics confounded:** raw aggregates moved Hit@5 0.810→0.762, MRR 0.712→0.389, Faithfulness 0.768→0.624, Context Recall 0.767→**0.800↑**, Answer Relevancy 0.589→0.565, Refusal 1.000=. **BUT the rank-metric drops (MRR/Hit@5/Precision@5) are a MEASUREMENT ARTIFACT** of computing rank over the expansion-reordered output — ±1 neighbors are prepended to the GT (score=0, context-only), pushing a rank-1 GT to rank 2 (e.g. q002 MRR 1.0→0.5). **Rank-independent GT coverage held/improved** (q014/q017 GT now retrieved; no GT actually dropped). **Substantive-answer faithfulness is FLAT 0.841→0.847** — the aggregate drop is refusal-scoring noise (Ragas scores refusals 0/1 erratically) + 2 query failures. **2 real failures: q007/q024 (both ep 294) returned HTTP 500 `OutputRejectedException reason=missing_citation`** — the LLM, given the 11-12-chunk expanded context, wrote long (1228/727-char) answers WITHOUT `[Source N]` markers; plausibly expansion-aggravated (more sources → uncited summary), LLM nondeterminism not excluded. **4 original failures:** q014✅+q017✅ FIXED (GT retrieved, faith 1.0); q006/q012 still miss GT (q006 now answers faithfully from adjacent chunks; q012 vector-limitation, refuses) — matches predictions. **Methodology finding for future runs:** rank-based retrieval metrics should be computed over the FUSED top-5 (pre-expansion), not the expanded order, or they will always read as regressions when expansion is on. **Reranker decision:** eval does NOT strongly support adding one now (q006 already answers faithfully; the urgent items are the rank-metric confound + the 2 citation 500s, which a reranker wouldn't fix). See `docs/phases/phase-4.md` §4.5.
- **Citation-500 root cause FIXED (2026-06-13) — `OutputValidationService` now accepts bare `[N]`:** the 4.5 q007/q024 `missing_citation` 500s were root-caused by a deterministic 20-run investigation (ON: 0/10 pass, OFF: 10/10 pass, byte-identical at temp-0): under the expanded 9-11-chunk context the LLM **abbreviates citations from `[Source N]` to bare `[N]`** (e.g. `[2, 3]`, `[5, 9]`); answers are fully grounded, only the marker format differs. The validator regex required the literal `Source` token → false `missing_citation` → HTTP 500. **Fix:** loosened the citation regex to `/\[\s*(?:Source\s+)?\d+(?:\s*,\s*(?:Source\s+)?\d+)*\s*\]/i` — accepts both `[Source N]` and bare `[N]`/`[N, M]`; digitless brackets (`[]`/`[Source]`/`[abc]`) still rejected. Superset change → zero risk to q014/q017 (they emit `[Source N]`, still pass). Live-verified: q007/q024 now 200, q017 still 200. +4 unit tests, full suite 438→442, 0 regressions. NOT an expansion/retrieval/prompt change — validator-only.
- **Eval methodology FIXED (2026-06-14) — rank metrics over fused top-5, generation over expanded context:** the 4.5 false rank regressions (MRR 0.712→0.389, Hit@5 0.810→0.762) were a measurement flaw — rank metrics were scored over the **expansion-reordered** list, where ±1 neighbors (score 0) are prepended to their parent, pushing a GT chunk down a rank (q002 GT was rank-1 → read as rank-2 → false MRR 0.5). **Fix (eval-infra + tiny API addition, NO retrieval/expansion/prompt logic change):** the QA response now carries `retrievalMetadata.fusedTopK` (the pre-expansion RRF top-5: `{chunkId, rrfScore, rank}`), surfaced via an optional `captureFusedTopK` observer callback in `RetrievalOptions` (zero churn on `retrieve()` return type; vector path reports its ranked list, hybrid reports the fused list before expansion). Eval **rank** metrics (MRR/Hit@5/Precision@5/Recall@5) now read `fusedTopK`; **generation** metrics (Faithfulness/Context Recall/Answer Relevancy) still read `sources` (the expanded context the LLM saw). Generation aggregates now also report a **substantive (non-refusal) split** (`substantive_faithfulness`/`substantive_answer_relevancy`/`refusal_count`) so Ragas's erratic refusal scoring stops deflating the headline. `sources` (expanded) unchanged for users; `baseline-2026-06-07` untouched (apples-to-apples: both = retrieval's final ranked list). Smoke-verified: q002 GT back at fused rank-1 (artifact gone); q014/q017 GT in fused top-5; q006/q012 honestly absent. +2 backend + 5 python tests, suites 442→444 / 115→120, 0 regressions. **A clean full 25-Q re-eval is the next step (separate, quota-gated) to get the TRUE Phase 4 numbers.** See `docs/phases/phase-4.md` §4.5.
- **4.5 FINAL CLEAN EVAL DONE (2026-06-14) — `evaluation/results/baseline-hybrid-final-2026-06-14/`** (single run, hybrid+expansion ON, corrected harness, post citation+methodology fixes; **25/25 successful, 0 failures**). **The TRUE Phase 4 numbers — strong, the 4.5 "regressions" confirmed as pure artifact.** 3-way (baseline-vec / 4.5-raw-flawed / final-corrected): **MRR 0.712 / 0.389 / `0.774`** (+0.062 vs baseline; the 0.389 was 100% neighbor-prepend artifact); **Hit@5 0.810 / 0.762 / `0.905`** (+0.095 = q014+q017 flipping 0→hit, 19/21); **Precision@5 0.248/0.229/`0.267`**; **Recall@5 0.786/0.738/`0.841`**; **Context Recall 0.767/0.800/`0.900`** (+0.133); **Faithfulness raw 0.768/0.624/`0.728`** (raw is refusal-deflated — 6 refusals scored 0/1) but **substantive (non-refusal) `0.905`** (vs baseline raw 0.768 / baseline-substantive ~0.841 → +0.064, generation quality UP not down); **Answer Relevancy raw 0.589/0.565/`0.631`, substantive `0.831`**; **Refusal 1.000** (4/4). **Four originals:** q014 (GT 226_chunk_14 @ fused rank 2) + q017 (269_chunk_306 @ rank 1) **FIXED**; q006 (305 @ fused rank 6, beyond top-5/±1 — answers faithfully from adjacent, faith 0.91) + q012 (GT invisible to both retrievers — vector-embedding limitation, correctly refuses) **documented misses**. **Regression check: 2 improved / 19 unchanged / 0 regressed — ZERO GT dropped at retrieval.** q007/q024 confirmed answered (citation fix held, no 500). Diagnostic verdict: HEALTHY at layer level (4.5's "generation hallucinating" + "MRR low" warnings gone); overall WARNING only from refusal-deflated Answer Relevancy + mathematically-capped Precision@5 (both known limitations, same as baseline). **Phase 4 retrieval goal achieved and defensible — ready for 4.6 (ADR/README/closure).** See `docs/phases/phase-4.md` §4.5.
- Scope: Elasticsearch BM25 keyword search + RRF fusion with the existing vector retrieval; post-fusion ±1 neighbor-chunk expansion
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