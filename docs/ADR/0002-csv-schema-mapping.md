# ADR 0002 — CSV column to LangChain Document mapping

- **Status:** Accepted
- **Date:** 2026-05-15
- **Phase:** 1.2 (Ingestion module structure + CSV understanding)
- **Related:** CLAUDE.md "Foundation reasoning Q3"; `docs/phases/phase-1.md` §1.2; `docs/architecture.md` "Ingestion flow (Phase 1)"

---

## Context

The project ingests podcast data from a single CSV with both unstructured text and structured columns:

```
episode_id, title, date, duration_min, guest_name, guest_affiliation, guest_role, transcript_text
```

LangChain represents a document as a `Document<Metadata>` with two fields:

- `pageContent: string` — the text that gets **chunked and embedded**, i.e. what semantic similarity is computed against.
- `metadata: Record<string, unknown>` — structured fields preserved alongside but **not embedded**. Used for retrieval filtering (Chroma `where` clauses) and for citation in the answer.

We need a deliberate rule for which CSV columns go into `pageContent` versus `metadata`, because the choice directly affects:

1. **Embedding quality** — anything in `pageContent` becomes part of the vector. Structured fields like dates or short titles add noise to the embedding without semantic payoff.
2. **Filterability** — anything in `metadata` is queryable as a Chroma `where` predicate (e.g., `guest_affiliation: "MIT"`, `duration_min: { $gt: 120 }`). Anything stuffed into `pageContent` is only reachable via semantic similarity, which is unreliable for exact filters.
3. **Citation quality** — sources are reported back to the user. Reliable citation requires structured access to `episode_id`, `guest_name`, etc., which only `metadata` guarantees.
4. **Future graph bridge (Phase 3+)** — `episode_id` and `guest_name` must appear in BOTH Chroma metadata and Neo4j node properties to enable hybrid retrieval. This forces them into metadata.

## Decision

- **`pageContent`** ← `transcript_text` **only**.
- **`metadata`** ← every other column:
  - `episode_id` (string, primary key, bridge to Neo4j)
  - `title` (string)
  - `date` (ISO date string)
  - `duration_min` (number)
  - `guest_name` (string, bridge to Neo4j)
  - `guest_affiliation` (string)
  - `guest_role` (string)

Chunking happens after this mapping: `RecursiveCharacterTextSplitter` splits `pageContent` while LangChain's loader contract automatically propagates the same `metadata` object to every resulting chunk. Each chunk additionally receives a deterministic ID `{episode_id}_chunk_{idx}` to make ingestion idempotent (re-running without `--reset` is a no-op for unchanged data).

## Alternatives considered

### A. Prefix `title` into `pageContent`

> e.g., `"[The Nature of Consciousness in Machines] In today's conversation..."`

**Rejected.** Reasons:

- Pollutes the embedding with words that are not part of the actual transcript content, biasing similarity for shallow lexical reasons (the title would appear in every chunk of an episode and inflate score on title-matching queries).
- The title is already filterable and citable via metadata — putting it in `pageContent` is redundant for retrieval and harmful for embedding fidelity.
- Industry-standard RAG guidance (LlamaIndex docs, LangChain docs, Pinecone best practices) all separate "what to embed" from "what to retrieve alongside."

### B. Concatenate metadata as a header block into `pageContent`

> e.g., `"Guest: Sarah Chen\nAffiliation: Stanford\nDate: 2024-01-15\n\n<transcript>"`

**Rejected.** Same embedding-pollution argument as (A), worse because it pollutes with multiple fields and the same prefix appears identically in every chunk, dragging cosine similarity in unpredictable directions. Also wastes tokens — each chunk pays for the same header.

### C. Embed `title + transcript` as two separate Documents per episode

**Rejected.** Increases storage and query latency for marginal recall gain. The title rarely contains information not also present in the first paragraph of the transcript itself, and where it does, semantic similarity on the transcript chunks is usually sufficient. Reconsider if Phase 2 evaluation shows recall failures specifically on title-only-content questions.

### D. Skip `episode_id` from metadata and use the document's auto-generated ID

**Rejected.** Auto-generated IDs are opaque, non-deterministic, and break the Phase 3 bridge to Neo4j. Idempotent re-ingestion also requires a stable ID derived from the source.

## Consequences

### Positive

- Embeddings reflect only transcript semantics — high signal-to-noise ratio for similarity search.
- All structured fields are filterable in Chroma (`where` clauses) and citable in answers.
- `episode_id` and `guest_name` are reusable as Neo4j keys in Phase 3 without re-ingestion (the "bridge" pattern in CLAUDE.md is already wired at this layer).
- Idempotency is straightforward: deterministic chunk ID = `{episode_id}_chunk_{idx}`.

### Negative / trade-offs

- Chroma metadata payload grows linearly with chunk count (7 fields × N chunks per episode). For the sample (15 episodes × ~10 chunks each) this is trivial; for the full Lex Fridman dataset (~325 episodes × tens of chunks each) total metadata is still well under Chroma's per-collection limits — estimated single-digit MB. Acceptable.
- Filtering on free-text fields (`title`, `guest_role`) requires exact-match Chroma predicates. Fuzzy matching is not supported at this layer. Mitigation: such queries fall through to semantic similarity (the title's keywords typically appear in the transcript anyway).
- Chroma metadata field names should be ASCII, no dots or `$` (client-level constraint per Chroma JS docs). Our chosen field names already satisfy this. The constraint will be documented in CLAUDE.md if we hit any surprise.

### Implications for the real (Lex Fridman) dataset

The HuggingFace source dataset (`nmac/lex_fridman_podcast`) provides only:

- `id` → maps to `episode_id`
- `title` → `title`
- `guest` → `guest_name`
- `text` → `transcript_text`
- `end` → derived to `duration_min` (rounded)

The following columns are **not present** in the source and will be empty strings in `data/podcasts.csv` after running `scripts/prepare_dataset.py`:

- `date` — not in the dataset card; could be backfilled by scraping podcast feed metadata in a later phase (out of scope for now).
- `guest_affiliation` — to be filled by **LLM-based entity extraction in Phase 3**, where a Zod-schema-controlled extractor reads the transcript and emits `(Person, AFFILIATED_WITH, Company)` triples. The resulting affiliations will be backfilled into Chroma metadata via an update pass (or stored only in Neo4j and joined at query time — to be decided in Phase 3 ADR).
- `guest_role` — same path as `guest_affiliation`.

Empty-string defaults are intentional: they keep the schema uniform across sample and full datasets, and the empty values are visible (and filterable as `=""`) when debugging. The smaller hand-curated `data/sample-podcasts.csv` ships with all fields populated so Phase 1 smoke tests do not depend on Phase 3 extraction.

### Implications for ingestion code (1.3)

- `CsvLoaderService` must parse CSV with proper quoting (transcripts contain commas, quotes, and newlines).
- After loading, each row produces one `Document` whose `pageContent` is `transcript_text` and whose `metadata` is the typed projection of the remaining columns. `duration_min` must be parsed as `number` (not string) to enable Chroma numeric `where` predicates like `{ $gt: 120 }`.
- Chunking must preserve the metadata object reference (or a copy with identical keys) on every resulting chunk; verified via unit test in 1.3.
