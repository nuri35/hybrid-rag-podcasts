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
- **Graph store:** Neo4j (community edition or Aura — Phase 3+)
- **Embedding model:** OpenAI `text-embedding-3-small` (1536 dim)
- **Generation model:** `gpt-4o-mini` (configurable via env)
- **Schema validation:** Zod (LLM outputs) + class-validator (HTTP DTOs)
- **CLI:** nest-commander
- **Testing:** Jest (unit + e2e)
- **Evaluation:** Ragas-equivalent metrics via LangChain.js evaluation tools (Phase 2)

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

9. **Embedding provider is Google Gemini `text-embedding-004` (768 dim, free tier).** Parallelism is 5 in-flight batches via `p-limit`; batch failures are isolated via `Promise.allSettled`; LangChain handles per-batch retry (3 attempts). Switching provider requires re-ingestion since vector spaces differ. (`@google/generative-ai` is installed at root with `--legacy-peer-deps` because chromadb 1.x declares a stale `^0.1.1` peer dep that doesn't affect actual chromadb usage — see `package.json`.)

10. **Text cleaning is a dedicated service between CSV load and chunking.** It applies three levels of normalization: unicode/whitespace/punctuation/sentence-dedup (always), Lex Fridman intro/outro stripping (default on, anchor-phrase-based with safe no-match fallback), sponsor/filler removal (deferred to Phase 2, currently warning-log stubs). All rules are deterministic regex — no LLM involvement, idempotent, dependency-free. See ADR 0004.

11. **Chroma deployment and metric strategy.** Local Chroma server via docker-compose (named volume on Windows for performance, gitignored). Raw `chromadb` JS client (no LangChain wrapper — we supply pre-computed Gemini vectors and need direct control over `upsert`). **Distance metric uses Chroma's default L2; equivalence to cosine is achieved by normalizing all vectors to unit length at embed time** (see `EmbedderService.normalizeVector`). For unit vectors L2 distance ranking is mathematically identical to cosine similarity ranking (`cos(a,b) = 1 − L²(a,b)/2` when `||a||=||b||=1`). This is metric-agnostic, robust across Chroma versions, and matches how Sentence Transformers, OpenAI, and Pinecone recommend handling non-normalized embeddings like Gemini's. Query vectors must be normalized the same way at retrieval (Phase 1.5). The chromadb 1.10.x JS client does NOT expose the Configuration API for HNSW space; `metadata['hnsw:space']` is silently ignored, and direct POSTs to the configuration endpoint require Pydantic-internal `_type` discriminators that are not documented — we chose normalization over fragile internal-API hacking. See ADR 0006 decision 9.

12. **Idempotent ingestion via deterministic `chunk_id` + Chroma `upsert()`.** Re-running ingestion overwrites cleanly; same `{episode_id}_chunk_{idx}` ID survives. `--reset` flag wipes the collection first when a clean state is required. Failures are atomic at the operation level (per-batch retry; throw `ChromaWriteFailedException` with full diagnostics if any batch fails after retries) — partial state on disk is benign because re-runs overwrite.

13. **Configurable write concurrency mirrors Pinecone's `pool_threads` semaphore pattern.** Default `CHROMA_WRITE_CONCURRENCY=3` parallel batches via `p-limit`. Local Chroma serializes HNSW writes server-side, so concurrency yields no local speedup — but no harm either. Remote deployments (different VM, Chroma Cloud) gain 15–33 % via network overlap; tuning is a single env change, never a code change.

14. **Production readiness baked in from day one.** Health check at module init via `client.heartbeat()` wrapped in a 5 s timeout — fails fast on a dead server before any Gemini quota is spent. Per-batch HTTP timeout (default 30 s, configurable). Retry-with-backoff for transient errors (`429`, 5xx, timeouts, `ECONNRESET`): up to 3 attempts with `1s → 2s → 4s` exponential delays plus ±200 ms jitter; permanent errors (4xx auth/validation) fail fast. Structured logs prefix events (`chroma_write_complete`, `chroma_batch_retry`) for log aggregators. Graceful shutdown via `OnModuleDestroy` + `SIGINT`/`SIGTERM` handling. Chroma Cloud auth via optional `CHROMA_API_KEY` + `CHROMA_API_KEY_HEADER` (default `X-Chroma-Token`) plumbed through `fetchOptions.headers`.

15. **Two-layer rate limiting in `EmbedderService` — token bucket (proactive) + adaptive retry (reactive).** Gemini Tier 1 caps the embedding endpoint at ~15 RPM and LangChain's default 7-second exponential backoff is shorter than Gemini's 60-second reset window, so the wrapper-level retry never escapes. `EmbedderService.waitForToken()` reserves atomic per-request slots via a monotonically advancing `lastRequestTime` (slot-reservation pattern is safe under concurrency, unlike a naive read-then-write). `EmbedderService.embedWithAdaptiveRetry()` then handles stray 429s AND the `@langchain/google-genai` 0.2.x silent-empty-array substitution (`Array(N).fill([])` returned when a `batchEmbedContents` call rejects) — both routes through short exponential backoff (200 ms → 2 s cap × 1.5 growth × up to 10 attempts by default). LangChain's internal retry is disabled (`maxRetries: 0`) to centralize retry logic. Atomic-success semantics preserved: a fully exhausted batch throws → `Promise.allSettled` records rejection → `EmbeddingFailedException` aborts ingestion. Tier-aware via env (`EMBEDDING_REQUESTS_PER_MINUTE` — Tier 1=15, Tier 2=60, Tier 3=200+), code unchanged across tiers. See ADR 0006 decision 10.

16. **HTTP endpoint design — URI versioning + strict global ValidationPipe + thin controller.** `app.enableVersioning({ type: VersioningType.URI, prefix: 'api/v' })` mounts every versioned controller under `/api/v<N>/...`; URI versioning was chosen over header- or media-type-based variants because (a) it shows up in curl/docs, (b) Swagger UI generates one path entry per version automatically, (c) future Phase 4 hybrid endpoints can opt into `version: '2'` without disturbing v1 consumers. `ValidationPipe` is global with `whitelist + forbidNonWhitelisted + transform + enableImplicitConversion`; `forbidNonWhitelisted` (reject, not silently strip) is deliberate so client typos surface as 400s instead of silent data loss. `QaController` is a thin pass-through (5 lines of logic): it converts the DTO into a service call and returns the result. Errors propagate unwrapped — `AllExceptionsFilter` (Phase 1.1) maps `QaChainFailedException`/`RetrievalFailedException` (extends `InternalServerErrorException` → 500) and `EmptyQueryException`/`QueryTooShort/Long/InvalidRetrievalOptions` (extends `BadRequestException` → 400) to the right HTTP status. No try/catch in the controller — that would just re-throw, since the filter already handles formatting. See ADR 0008.

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

Current phase: **Phase 1 complete.** Next: **Phase 2 — Evaluation (Ragas-style metrics + golden dataset).**

| Phase | Status | Goal |
|---|---|---|
| 1. Vector layer | ✅ Done | Working vector RAG with CLI ingestion + HTTP endpoint shipped |
| &nbsp;&nbsp;1.1 Repo init | ✅ Done | NestJS + TS strict scaffold, ConfigModule (Zod-validated env), HealthModule (`GET /health`), AllExceptionsFilter, `cli.ts` via nest-commander, ESLint/Prettier, folder structure per module spec |
| &nbsp;&nbsp;1.2 Ingestion scaffold + data prep | ✅ Done | `IngestionModule` with four `@Injectable` service skeletons (CsvLoader, Chunker, Embedder, IngestionPipeline) wired into `AppModule`; ADR 0002 documents CSV → Document mapping (pageContent=transcript_text, metadata=rest); `scripts/prepare_dataset.py` (one-time Lex Fridman HF download + schema remap) is the project's sole Python dependency; README has Data preparation + Usage sections |
| &nbsp;&nbsp;1.3.a + 1.3.b | ✅ Done | `CsvLoaderService` streams via csv-parse + Zod validation with skip+warn behavior (8 tests pass); `ChunkerService` uses `RecursiveCharacterTextSplitter` (800/100) and adds deterministic `chunk_id` + `chunk_index` + `total_chunks`; pipeline gained a `--dry-run` flag through `IngestCommand` and dry-run on full dataset reports 319 docs → 54,172 chunks |
| &nbsp;&nbsp;1.3.c | ✅ Done | `EmbedderService` implemented with Gemini `text-embedding-004` (768 dim), batch=100, concurrency=5, `Promise.allSettled` error handling (6 tests pass); non-dry pipeline now runs load → chunk → embed and throws NotImplemented for 1.3.e storage |
| &nbsp;&nbsp;1.3.d | ✅ Done | `TextCleanerService` — 3-level regex cleaning sits between load and chunk: Level 1 (unicode/quotes/spaces/newlines/punctuation/sentence-dedup) always on; Level 2 (Lex Fridman intro/outro anchor stripping) config-gated, default on; Level 3 (sponsors/fillers) deferred to Phase 2 with warning-log stubs; idempotent, dependency-free; 10 spec scenarios pass |
| &nbsp;&nbsp;1.3.e | ✅ Done | Production-grade `ChromaRepository` (15 unit tests pass): docker-compose-managed Chroma 0.5.23 server with healthcheck; configurable concurrency (default 3 via `p-limit`), batch size, retries, timeouts; per-batch retry-with-exponential-backoff for transient errors; `Promise.allSettled` + `ChromaWriteFailedException` on partial failure; module-init heartbeat fails fast; idempotent `upsert` semantics; `--reset` flag; Chroma Cloud auth support; graceful shutdown via `SIGINT`/`SIGTERM` + `OnModuleDestroy`. End-to-end pipeline wired (load → clean → chunk → embed → store). See ADR 0006. |
| &nbsp;&nbsp;1.3.f | ⚪ Pending | Streaming embed/write overlap — deferred, see Future optimizations |
| &nbsp;&nbsp;1.5 Retrieval | ✅ Done (+ hardening pass `efce868..e1cddb4`) | `VectorStoreModule` extracted as shared infrastructure; `EmbedderService.embedQuery` added with `RETRIEVAL_QUERY` task type and a dedicated client; new `RetrievalModule` with `VectorRetrieverService implements IRetriever` (top-K + score threshold + metadata filter + LCEL `toRunnable()` factory, 16 unit tests, 100% statement coverage); 4 integration tests against live Chroma+Gemini (skipped by default); cosine score formula fix in `ChromaRepository` (`1 − L2²/2`). **Post-ship hardening:** dead-code comment on catch ladder; `METADATA_KEYS` constant + warn-on-fallback for `chunk_index`; correlation-ID error wrapping in `RetrievalFailedException` (no leak of SDK detail to HTTP response); allow-list `sanitizeFilter()` (keys ∈ `METADATA_KEYS`, operators ∈ `{$eq, $in}`) before forwarding to Chroma. +11 unit tests (16 → 27). See ADR 0003 (original) + "Phase 1.5 hardening notes" amendment. |
| &nbsp;&nbsp;1.6 QA chain | ✅ Done (+ hardening pass `c45646d..8829caa`, + Sprint Retry `82339ab..0c2b739`, + Sprint Streaming `7616b3a..dbe4c7f`) | `LlmModule` (shared Gemini chat-model factory) + `QaModule` with `QaChainService` (LCEL `prompt | llm | StringOutputParser`; retrieval invoked outside the chain so empty-context fallback can skip the LLM call; pass-through error mapping for known retrieval/embedding exceptions, `QaChainFailedException` wraps the rest). **LLM_MODEL = `gemini-2.5-flash-lite`** (migrated from `gemini-2.0-flash` on 2026-05-19 after Google deprecated 2.0-flash for new accounts — returns 404; flash-lite chosen for free-tier quota + GA stability; pinned, no `-latest` alias). 9 unit tests (100 % statements) + 3 integration tests (skipped). Manual smoke test CLI `scripts/test_qa.ts` via `npm run qa -- "<question>"`. **Post-ship hardening:** `NO_INFO_ANSWER` constant in `qa.constants.ts` as single source of truth (fast-path + prompt template); LCEL chain built once in the constructor; `qa_complete` log gained `top_score`/`avg_score`/`min_score` (4-decimal) for Phase 2 baselining; correlation-ID error wrapping in `QaChainFailedException` (no leak of SDK detail to HTTP response, mirrors Phase 1.5); `LLM_TIMEOUT_MS` now enforced via `Promise.race`-backed `invokeWithTimeout()`; `cleanAnswer()` post-processing (trim + conservative LLM-preamble strip); strengthened prompt template (5-rule block: ONLY context + no fabrication, `NO_INFO_ANSWER` fallback, `[Source N]` citation, length guidance, injection-resistance). +10 unit tests (9 → 19). See ADR 0007 (original) + "Phase 1.6 hardening notes" amendment. **Sprint Retry (3-phase, production-grade LLM resilience):** `RetryPolicyService` (exp backoff + jitter, retryable-error classification by HTTP status / Node code / message-pattern fallback); `CircuitBreakerService` (three-state CLOSED→OPEN→HALF_OPEN over rolling failure window, in-memory per process); `ResilientLlmService` composer (circuit outer + retry inner around every `chain.invoke`). Wired into `QaChainService.ask()` inside the existing `LLM_TIMEOUT_MS` race; `CircuitOpenException` (503 with `retryAfterSeconds`) + `RetryExhaustedException` added to pass-through ladder. 5 new env vars for retry tuning + 3 for circuit. +44 unit tests (qa-chain 27→31, +21 retry-policy, +13 circuit-breaker, +7 resilient-llm, +4 qa-chain integration). See ADR 0010. **Sprint Streaming (3-step, SSE token-by-token):** new `POST /api/v1/questions/stream` endpoint alongside the unchanged non-streaming endpoint; both share lock guard / integrity check / retrieval / prompt template / resilience layer — only the LLM invocation differs (`chain.stream` vs `chain.invoke`). `ResilientLlmService.streamChain` extends the composer for streams with **initiation-only protection**: circuit + retry wrap the `chain.stream()` Promise resolution (auth / 4xx-5xx surface here); the subsequent `for await` consumption is intentionally unprotected (partial streams cannot be cleanly replayed, and a stream that began emitting tokens implies upstream was healthy). `QaChainService.askStream` mirrors `ask()` shape but yields a `StreamEvent` sequence (`sources` → `token`* → `done` | `error`); same pre-yield guards, same retrieval. `invokeStreamWithTimeout` applies `LLM_TIMEOUT_MS` ONLY to first-chunk arrival — total stream duration is unbounded. SSE controller uses `new Observable<MessageEvent>(...)` with explicit subscriber control (NOT `merge(events$, heartbeat$)` — that leaks the unbounded `interval$`); heartbeats are typed JSON `{type:"heartbeat"}` every 15 s (NOT SSE comment lines — better cross-client portability); client disconnects call `generator.return()` so the for-await cancels cleanly. +23 unit tests (+7 streamChain in resilient-llm spec, +10 askStream in qa-chain spec, +6 controller streaming spec). See ADR 0011. |
| &nbsp;&nbsp;1.7 HTTP endpoint | ✅ Done (+ hardening pass `2068adc..8d60430`) | `QaController` (`POST /api/v1/questions`) + `AskQuestionDto` (class-validator min/max length, topK range, `IsInt`) + `QaResponseDto`/`QaSourceDto` (Swagger-annotated). URI versioning via `app.enableVersioning({ type: URI, prefix: 'api/v' })`. Global `ValidationPipe` with `whitelist + forbidNonWhitelisted + transform`. Swagger UI at `/api/docs`, OpenAPI JSON at `/api/docs-json`. 16 unit tests (6 controller via mocked `QaChainService`, 10 DTO via `plainToInstance + validate`). 6 live smoke probes confirmed: Swagger UI 200, OpenAPI schemas present, 3× validation 400s (too-short, extra-field, topK out-of-range), happy-path 200 in 3 s with 3 grounded sources. **Post-ship hardening (DX-first, contrast with 1.5/1.6 safety-first):** richer `@ApiProperty` descriptions across all 3 DTOs (embedding model + score formula + excerpt truncation + metadata caveat); new `ValidationErrorResponseDto` wired into `@ApiResponse(400)` to document the validation envelope explicitly (RFC 7807 migration stays Phase 1.7.5); three named `@ApiBody` examples (`philosophy` / `techQuestion` / `multiPerspective`); `DocumentBuilder` gained `.setContact() + .setLicense('MIT') + .addServer('http://localhost:3000')`; **10 KB body-size limit** enforced via custom `ExpressAdapter` + `{ bodyParser: false }` (plan's literal `app.use(json())` form is a no-op under NestJS Express because the default 100 KB parser registers ahead of the router during `init()` — verified empirically against `express 5.x`); **dev-only CORS** (`NODE_ENV !== 'production'`-gated, 3 common frontend ports, methods `GET+POST` only); first HTTP integration spec (`qa.controller.integration.spec.ts`, 6 supertest tests, skip-by-default, bootstrap mirrors `main.ts` faithfully); `supertest ^7.2.2` + `@types/supertest ^7.2.0` added as devDeps. Tests: 128 → 134 (+6 skipped), 120 passing unchanged. See ADR 0008 (original) + "Phase 1.7 hardening notes" amendment. |
| 2. Evaluation | ⚪ Pending | Ragas-style metrics + golden dataset (30–50 Q-A pairs) |
| 3. Graph layer | ⚪ Pending | Neo4j entity graph (deterministic + LLM-based extraction) |
| 4. Hybrid retrieval | ⚪ Pending | Combine vector + graph (sequential + parallel strategies) |
| 5. Query routing | ⚪ Pending | LLM tool use for adaptive retrieval routing |
| 6. Queue-based ingestion | ⚪ Future | Async ingestion via queue/worker pattern (optional) |

**Update this table when a phase completes.** Add a brief note about what was shipped.

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
- `ragas-evaluation` — when working on evaluation harness *(to be added in Phase 2)*
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