# Changelog

All notable changes to **hybrid-rag-podcasts** are documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each phase from the project plan (`CLAUDE.md` Phase tracking table) gets one entry.

## [Phase 1.6] — QaChainService + LlmModule (LCEL composition) — 2026-05-20

### Added
- `src/modules/llm/` — `LlmModule` and `LlmService.createChatModel()`, a
  factory that returns a fresh `ChatGoogleGenerativeAI` per call so future
  callers (evaluation harness, query router) can override `temperature`
  or `maxOutputTokens` without sharing state.
- `src/modules/qa/` — `QaModule` with `QaChainService.ask(question, options)`:
  - LCEL chain `PromptTemplate | ChatGoogleGenerativeAI | StringOutputParser`.
  - Retrieval runs OUTSIDE the chain so an empty-chunks fallback can
    short-circuit the LLM call (cost + latency win on out-of-domain queries).
  - Pass-through routing (`instanceof`, not constructor-name) for known
    retrieval / embedding / Chroma exceptions — preserves HTTP status codes
    once Phase 1.7 wires the controller.
- `QaChainFailedException` — wraps unknown LLM / chain errors as 500.
- `QaResult`, `QaSource`, `QaOptions` public contract types.
- 6 environment variables: `LLM_MODEL`, `LLM_TEMPERATURE`,
  `LLM_MAX_OUTPUT_TOKENS`, `LLM_TIMEOUT_MS`, `QA_DEFAULT_TOP_K`,
  `QA_SOURCE_EXCERPT_LENGTH`. All Zod-validated in the central env schema.
- `scripts/test_qa.ts` (`npm run qa -- "<question>"`) — manual smoke test
  CLI; bootstraps `AppModule` (no HTTP server), runs one question, prints
  answer + 5 sources + duration, exits cleanly.
- ADR-0007 — `LlmModule` + `QaChainService` design (10 decisions).

### Changed
- `LLM_MODEL` migrated from `gemini-2.0-flash` to `gemini-2.5-flash-lite`
  (commit 55a1942). Google deprecated `gemini-2.0-flash` for new accounts
  on 2026-03-06; the project's API key returned 404 once the smoke test
  hit the live endpoint. Flash-lite selected for GA stability, free-tier
  quota, and reproducible pinned version (no `-latest` alias).
- `AppModule` imports `LlmModule` and `QaModule` so the smoke test CLI
  and the Phase 1.7 controller can resolve `QaChainService`.

### Tests
- 9 unit tests for `QaChainService` (100 % statement coverage, 93.75 %
  branch coverage) using `FakeListChatModel` from
  `@langchain/core/utils/testing` — exercises the real LCEL composition
  without burning Gemini quota.
- 3 integration tests against live Chroma + Gemini (skipped by default,
  same convention as Phase 1.5 retrieval integration).
- Project total: 83 passed / 8 skipped (5 prior integration + 3 new QA
  integration). Lint clean across `src/**/*.ts`.

### Manual verification
- 6 smoke-test queries against the populated 53 427-vector collection:
  specific-entity, generic-concept, multi-perspective synthesis, and
  off-topic fallback all returned grounded answers with valid sources.
- Latency baseline on `gemini-2.5-flash-lite` free tier: ~6 s warm, 15–18 s
  on cold start or longer answers. Phase 2 evaluation will decide whether
  this is acceptable or whether to bump to `gemini-2.5-flash` paid tier.

## [Phase 1.5] — VectorRetrieverService — 2026-05-19

### Added
- `EmbedderService.embedQuery(text)` — query-side embedding with `RETRIEVAL_QUERY`
  task type. Reuses the same token bucket + adaptive retry as document
  embedding via a second LangChain client. +7 unit tests.
- `src/modules/vector-store/` — `VectorStoreModule` extracted from
  `IngestionModule` so both ingestion and retrieval consume the same
  `ChromaRepository` singleton. Chroma exceptions moved alongside.
- `src/modules/retrieval/` — new module with:
  - `VectorRetrieverService implements IRetriever` (top-K retrieval, LCEL
    `toRunnable()` factory, 16 unit tests at 100% statement coverage).
  - 5 HttpException-extending custom exceptions
    (`EmptyQuery`, `QueryTooShort`, `QueryTooLong`, `InvalidRetrievalOptions` →
    400; `RetrievalFailed` → 500).
  - 4 skipped integration tests against live Chroma + Gemini.
- ADR-0003 — vector store module separation rationale.

### Changed
- `ChromaRepository.similaritySearch` score formula corrected from
  `1 − distance` (assumed cosine distance) to `1 − L2² / 2` (correct for
  L2-on-unit-vectors → cosine equivalence). Score now lives in `[0, 1]` and
  is clamped at the floor. One spec assertion updated.
- `IngestionModule` now exports `EmbedderService` so `RetrievalModule` can
  consume it without extracting a third module.

### Tests
- 74/79 pass (5 skipped — 1 prior Chroma integration + 4 new retrieval
  integration). +23 unit tests since end of Phase 1.3.e.

## [Phase 1.3.e] — Production-grade ChromaRepository — 2026-05-18

### Added
- `ChromaRepository` (production-grade, 15 unit tests).
- docker-compose-managed Chroma 0.5.23 server with healthcheck, persistent
  named volume (Windows-bind-mount-safe), configurable concurrency, batch
  size, retries, timeouts.
- Per-batch retry-with-exponential-backoff for transient errors;
  `Promise.allSettled` + `ChromaWriteFailedException` on partial failure.
- Module-init heartbeat that fails fast on unreachable server.
- Idempotent `upsert()` semantics; `--reset` flag wipes collection.
- Chroma Cloud auth header support (optional).
- Graceful shutdown via `OnModuleDestroy` + `SIGINT`/`SIGTERM`.
- Vector normalization in `EmbedderService` (defensive, idempotent for
  `gemini-embedding-001`) — L2 ranking ≡ cosine ranking for unit vectors.
- Two-layer rate limiting (token bucket + adaptive retry) so Tier 1 Gemini
  quota does not abort the full-dataset ingest.
- ADR-0006 — Chroma repository design.

### Changed
- Embedding model migrated `text-embedding-004` (404 in `v1beta`) →
  `gemini-embedding-001` (3072 dim).

## [Phase 1.3.d] — TextCleanerService — 2026-05-15

### Added
- `TextCleanerService` — three-level deterministic regex cleaning between
  load and chunk. Idempotent, dependency-free.
- ADR-0004 — text cleaning strategy.

### Changed
- Pipeline order: load → **clean** → chunk → embed → store.

## [Phase 1.3.a + 1.3.b] — CSV loader + chunker — 2026-05-13

### Added
- `CsvLoaderService` (streaming csv-parse + Zod, skip-and-warn behaviour).
- `ChunkerService` (RecursiveCharacterTextSplitter 800/100, deterministic
  `chunk_id`).
- `IngestionPipelineService` + `IngestCommand` (`--dry-run`, `--reset`).
- `data/podcasts.csv` — 319 episodes via `scripts/prepare_dataset.py`.
- ADR-0002 — CSV → Document mapping.
- ADR-0005 — chronological segment ordering (HuggingFace data quirk fix).

## [Phase 1.3.c] — EmbedderService — 2026-05-14

### Added
- `EmbedderService` with Gemini embeddings, batching, concurrency,
  `Promise.allSettled` partial-failure handling.

## [Phase 1.2] — Ingestion scaffold + data prep — 2026-05-13

### Added
- `IngestionModule` skeleton with four service stubs.
- `scripts/prepare_dataset.py` — one-time Lex Fridman HF download + remap.
- README "Data preparation" + "Usage" sections.

## [Phase 1.1] — Repo init — 2026-05-13

### Added
- NestJS + TS strict scaffold, Zod-validated `ConfigModule`,
  `HealthModule` (`GET /health`), `AllExceptionsFilter`, `cli.ts` via
  nest-commander, ESLint + Prettier, full folder structure.
