# Changelog

All notable changes to **hybrid-rag-podcasts** are documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each phase from the project plan (`CLAUDE.md` Phase tracking table) gets one entry.

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
