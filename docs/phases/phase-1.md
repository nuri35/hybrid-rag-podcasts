# Phase 1 — Vector Layer + CLI Ingestion + Basic Q&A Endpoint

**Status:** 🟡 In progress
**Goal:** A working vector RAG end to end: ingest the podcast CSV via CLI, store chunks in Chroma with metadata, expose `POST /api/v1/questions` that returns grounded answers with citations.

**Out of scope for Phase 1** (do not implement yet):
- Neo4j or any graph retrieval (Phase 3)
- Hybrid retrieval combining vector + graph (Phase 4)
- LLM-driven query routing or tool use (Phase 5)
- Evaluation harness with Ragas-style metrics (Phase 2)
- Reranking, MMR, query expansion (later refinements)
- Authentication, rate limiting, multi-tenancy
- Streaming responses
- Queue-based ingestion (Phase 6)

---

## Definition of done — Phase 1 ships when

1. `npm run cli -- ingest --csv data/sample-podcasts.csv --reset` succeeds, writes chunks to Chroma with full metadata.
2. `npm run start:dev` boots without errors. `GET /health` returns `200` with status JSON.
3. `POST /api/v1/questions` with a valid body returns a JSON response containing `answer`, `sources[]`, and `retrievalPath: "vector"`.
4. Manual smoke test: at least 5 questions from `docs/evaluation/golden-questions.md` (semantic + filter categories) return relevant, grounded answers.
5. Hallucination check: a question whose answer is NOT in the dataset triggers a refusal ("not in context"), not a fabricated answer.
6. README has install + run instructions verified by a fresh clone.
7. CLAUDE.md phase tracking updated to `✅ Complete` with a one-line summary.

---

## Sub-steps and acceptance criteria

### 1.1 — Repo and project setup

**Deliverables:**
- `.gitignore` covering Node, env files, Claude Code local state, `data/chroma/`
- `package.json` with all runtime + dev dependencies declared
- `tsconfig.json` with strict mode
- ESLint + Prettier configured
- Folder structure exactly per CLAUDE.md "Module structure"
- `src/main.ts`, `src/cli.ts`, `src/app.module.ts`
- `src/common/config/` with Zod-validated env schema
- `src/common/health/` with `GET /health` endpoint
- `src/common/exceptions/` and `src/common/filters/` with at least one custom exception and a global exception filter
- `.env.example` with all required vars
- `README.md` skeleton

**Acceptance criteria:**
- `npm run build` exits cleanly
- `npm run start:dev` starts, `GET /health` returns `200`
- `npm run cli -- --help` lists commands
- No `any` types anywhere; `eslint .` passes

### 1.2 — Ingestion module structure + CSV understanding

**Deliverables:**
- `src/modules/ingestion/` folder with module file and empty service skeletons
- Documented decision in `docs/ADR/0002-csv-schema-mapping.md` describing which CSV columns become `pageContent` vs `metadata`
- `IngestionModule` registered in `AppModule`

**Acceptance criteria:**
- Inspecting `data/sample-podcasts.csv` confirms expected columns
- `pageContent` mapping: `transcript_text`
- `metadata` mapping: `episode_id`, `title`, `date`, `duration_min`, `guest_name`, `guest_affiliation`, `guest_role`
- Empty pipeline service compiles and is DI-injectable

### 1.3 — Ingestion pipeline implementation

**Deliverables:**
- `CsvLoaderService` using LangChain `CSVLoader` (or a custom parser if metadata flexibility needed)
- `ChunkerService` wrapping `RecursiveCharacterTextSplitter` with `chunk_size: 800, chunk_overlap: 100`. Metadata MUST propagate to every chunk.
- `EmbedderService` wrapping `OpenAIEmbeddings`. Batches requests (≥ 50 chunks per call). Implements retry with exponential backoff for transient errors.
- `ChromaRepository` in `src/common/repositories/` wrapping `ChromaClient`. Methods: `addDocuments`, `similaritySearch`, `resetCollection`.
- `IngestionPipelineService` orchestrating loader → chunker → embedder → repository.

**Acceptance criteria:**
- Pipeline is fully DI-wired
- Idempotency: running ingest twice without `--reset` does not duplicate (use deterministic chunk IDs: `{episode_id}_chunk_{idx}`)
- `--reset` flag clears the collection before writing
- Progress logs every N chunks (configurable, default 50)
- Final log line summarizes: rows processed, chunks created, tokens consumed, duration, estimated cost

### 1.4 — CLI command via nest-commander

**Deliverables:**
- `IngestCommand` class in `src/modules/ingestion/commands/`
- `@Command({ name: 'ingest' })` decorator
- Options: `--csv <path>` (required), `--reset` (optional flag), `--collection <name>` (optional, defaults from env)
- `src/cli.ts` bootstraps `CommandFactory.run(AppModule)`
- `npm run cli` script in `package.json`

**Acceptance criteria:**
- `npm run cli -- ingest --csv data/sample-podcasts.csv` works end-to-end with sample data
- `--reset` flag correctly clears collection before ingest
- Helpful error message if CSV path is invalid
- Exit code `0` on success, `1` on failure

### 1.5 — Vector retriever as Runnable factory

**Deliverables:**
- `VectorRetrieverService` in `src/modules/rag/retrievers/`
- `build(options: VectorRetrievalOptions): Runnable<{ question: string }, Document[]>`
- Options include: `k` (default 5), `filter?` (Chroma `where` clause), `scoreThreshold?` (optional float)
- Service depends on `ChromaRepository` via DI

**Acceptance criteria:**
- Returns a Runnable, not a Promise — composable via `.pipe()`
- Calling `.invoke({ question: "test" })` returns `Document[]` with `pageContent` and full `metadata`
- `filter` option correctly applied (e.g., `{ guest_affiliation: "MIT" }`)
- Unit test: mock `ChromaRepository`, verify correct call with expected args

### 1.6 — QA chain via LCEL composition

**Deliverables:**
- `qa-prompt.ts` in `src/modules/rag/prompts/` with the QA prompt template (see `docs/prompts/qa-prompt-v1.md` once written)
- `QaChainService` in `src/modules/rag/chains/`
- `build(): Runnable<{ question: string }, QaChainOutput>`
- Composition: `RunnableParallel({ context: vectorRetriever | formatContext, question: passthrough })` → `prompt` → `model` → `outputParser`
- Output shape: `{ answer: string, sources: SourceDocument[] }`

**Acceptance criteria:**
- Chain is built once in service constructor; not rebuilt per request
- Prompt instructs the model: "answer only from context, cite episode_id and guest_name, say so if context lacks the answer"
- `formatContext` step builds a string like: `[ep_001 / Sarah Chen / Stanford]\n<chunk text>\n\n...`
- `outputParser` extracts `answer` text and reattaches the `sources` (Documents from retriever) to produce final output
- Unit test: with mock model returning a known string, full chain produces expected `QaChainOutput`

### 1.7 — Public endpoint

**Deliverables:**
- `QuestionsModule` registered in `AppModule`
- `QuestionsController` with `POST /api/v1/questions`
- `AskQuestionDto` with class-validator: `question: string`, `MinLength(3)`, `MaxLength(500)`
- `QuestionResponseDto`: `answer: string`, `sources: SourceDto[]`, `retrievalPath: 'vector'`
- `SourceDto`: `episodeId: string`, `guestName: string`, `affiliation: string`, `snippet: string` (truncated 200 chars)
- `QuestionsService` delegating to `QaChainService.build().invoke(...)`
- Global `ValidationPipe` enabled in `main.ts`

**Acceptance criteria:**
- `curl -X POST http://localhost:3000/api/v1/questions -H 'Content-Type: application/json' -d '{"question":"What did guests say about consciousness?"}'` returns valid JSON
- Invalid input (too short, missing field) returns `400` with structured error from `ValidationPipe`
- Service errors are caught by exception filter and return `503` with a clean message

### 1.8 — Smoke test and manual validation

**Deliverables:**
- Run at least 10 questions from `docs/evaluation/golden-questions.md` (semantic + filter categories) and document results in `docs/evaluation/phase-1-smoke-results.md`
- One of the questions must be intentionally answerable ONLY from outside the dataset (to test refusal)
- Document any unexpected behavior or failure patterns

**Acceptance criteria:**
- ≥ 80% of relevant questions return a grounded answer with correct citation
- Refusal test passes: model says "not in context" rather than hallucinating
- Edge cases tried: very short question (3 chars), very long question (500 chars), question with non-ASCII characters (Turkish, emoji), question with no semantically close chunks

### 1.9 — Phase 1 closeout

**Deliverables:**
- README updated with: project description, prerequisites, install steps, env setup, ingest command, query example with `curl`, link to CLAUDE.md and `docs/architecture.md`
- `CHANGELOG.md` created with Phase 1 entry: what shipped, what is intentionally not yet shipped
- CLAUDE.md phase tracking: Phase 1 → `✅ Complete` with one-line summary
- Git commit + push to `main` (or PR if working on branch)
- Optional: short LinkedIn post draft about shipping Phase 1

**Acceptance criteria:**
- Fresh clone + follow README + ingest + run + curl = success in under 10 minutes
- `chroma-vector-store` skill added to `.claude/skills/` (per CLAUDE.md "When to consult skills" plan)

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| OpenAI rate limits during bulk ingestion | Batch + exponential backoff in `EmbedderService` |
| Chroma metadata field name restrictions | Validate field names before write; document constraint in CLAUDE.md if hit |
| LangChain.js API drift between versions | Pin exact versions in `package.json`; document working versions in README |
| Token cost surprise on large CSV | Cost estimator log line before write; require explicit `--confirm` if estimate exceeds threshold |
| Idempotency bugs causing duplicates | Deterministic chunk IDs from `episode_id` + chunk index |