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
  - Transcript → unstructured → chunk + embed → Chroma
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
    rag/                          # Retrievers, chains, prompts
      retrievers/
        vector-retriever.service.ts
        graph-retriever.service.ts          # Phase 3+
        hybrid-retriever.service.ts         # Phase 4+
      chains/
        qa-chain.service.ts
      prompts/
        qa-prompt.ts
      rag.module.ts
    questions/                    # Public HTTP endpoint
      questions.controller.ts
      questions.service.ts
      dto/
        ask-question.dto.ts
        question-response.dto.ts
      questions.module.ts
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

Current phase: **Phase 1 — Vector layer + CLI ingestion + basic Q&A endpoint**

| Phase | Status | Goal |
|---|---|---|
| 1. Vector layer | 🟡 In progress | Working vector RAG with CLI ingestion |
| &nbsp;&nbsp;1.1 Repo init | ✅ Done | NestJS + TS strict scaffold, ConfigModule (Zod-validated env), HealthModule (`GET /health`), AllExceptionsFilter, `cli.ts` via nest-commander, ESLint/Prettier, folder structure per module spec |
| &nbsp;&nbsp;1.2 Ingestion scaffold + data prep | ✅ Done | `IngestionModule` with four `@Injectable` service skeletons (CsvLoader, Chunker, Embedder, IngestionPipeline) wired into `AppModule`; ADR 0002 documents CSV → Document mapping (pageContent=transcript_text, metadata=rest); `scripts/prepare_dataset.py` (one-time Lex Fridman HF download + schema remap) is the project's sole Python dependency; README has Data preparation + Usage sections |
| &nbsp;&nbsp;1.3.a + 1.3.b | ✅ Done | `CsvLoaderService` streams via csv-parse + Zod validation with skip+warn behavior (8 tests pass); `ChunkerService` uses `RecursiveCharacterTextSplitter` (800/100) and adds deterministic `chunk_id` + `chunk_index` + `total_chunks`; pipeline gained a `--dry-run` flag through `IngestCommand` and dry-run on full dataset reports 319 docs → 54,172 chunks |
| &nbsp;&nbsp;1.3.c | ✅ Done | `EmbedderService` implemented with Gemini `text-embedding-004` (768 dim), batch=100, concurrency=5, `Promise.allSettled` error handling (6 tests pass); non-dry pipeline now runs load → chunk → embed and throws NotImplemented for 1.3.d storage |
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