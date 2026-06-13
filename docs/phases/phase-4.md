# Phase 4 — Hybrid Retrieval (Vector + Elasticsearch + RRF)

**Status:** 🟡 In progress
**Started:** 2026-06-10
**Estimated completion:** 9–12 days (~2 weeks)
**Baseline to beat:** `evaluation/results/baseline-2026-06-07/`

> **Plan revision (2026-06-10):** the keyword-search engine was switched from an
> in-process BM25 library (`rank_bm25`) to **Elasticsearch**. See
> "Rationale for Elasticsearch" below. The earlier "Open architectural question"
> (Python sidecar vs TS in-process) is resolved: Elasticsearch is a standalone
> backing service like Chroma/Redis/Neo4j, so the "single NestJS service / no
> Python sidecar" decision (CLAUDE.md architectural decision 1) is fully honored.

> Note on file location: this plan lives at `docs/phases/phase-4.md` to match the
> existing `docs/phases/phase-1.md` convention (CLAUDE.md References points
> "Phase plans and progress" at `docs/phases/`). The kickoff spec named it
> `docs/phase-4-plan.md`; the repo convention is followed here instead.

> Note on phase sequencing: Phase 4 (hybrid retrieval) is being implemented
> BEFORE Phase 3 (Neo4j graph layer). The 4 zero-hit baseline questions are a
> vocabulary-mismatch problem that keyword search solves directly, making this
> the higher-value next step. Phase 4 is also **redefined** from the original
> "vector + graph" fusion to "vector + BM25 keyword" fusion; graph-based hybrid
> is deferred to a later phase.

---

## Scope

**In scope:**
- BM25 keyword search via Elasticsearch (standalone Docker Compose service)
- RRF (Reciprocal Rank Fusion) to merge vector + Elasticsearch rankings
- Hybrid retrieval pipeline integrated into the RAG flow
- A new baseline evaluation after implementation

**Out of scope (deferred):**
- Cross-encoder reranker (future enhancement sprint)
- Citation-accuracy custom metric (future enhancement)
- Graph RAG (Agentic AI phase)
- Agentic RAG (Agentic AI phase)

---

## Rationale

The Phase 2 baseline (2026-06-07) showed 4 questions with Hit@5 = 0 — complete
retrieval failure:

| ID | Topic | Hard term that vectors miss |
|---|---|---|
| q006 | Lee Cronin: biology is not a Turing machine | "Turing machine" |
| q012 | Sebastian Thrun: human walking & machine learning | "walking" as ML analogy |
| q014 | Jo Boaler: multidimensional approach to math | "multidimensional approach" |
| q017 | Lee Cronin: constructors vs abstractors | "constructors", "abstractors" |

All 4 hinge on specific terminology. Dense embeddings dilute rare technical
terms into the surrounding conversational text, so the relevant chunk never
ranks in the top-5. BM25 is strong at exactly this case: rare words score high
via TF-IDF weighting. Combining vector (semantic) + BM25 (lexical) via RRF is
the standard industry solution for this failure mode.

**Reranker excluded** because: high implementation cost (3–5 days), requires a
model decision, and — critically — does not fix the failing questions. A
reranker reorders an existing candidate set; if BM25 isn't there to surface the
missing chunk, reranking has nothing to promote. Reranker improves Precision@5,
which is not the baseline's problem.

---

## Rationale for Elasticsearch (over in-process BM25)

After installing `rank_bm25` in 4.1.1, the architecture decision was revisited.
Options considered:

1. **Python microservice (FastAPI + rank_bm25)** — Rejected. Violates the
   CLAUDE.md "single NestJS service / no Python sidecar" decision.
2. **TypeScript in-process library (`wink-bm25-text-search`)** — Rejected.
   Works at the current scale but signals "quick fix" rather than production
   thinking. Not stateless, harder to scale, keeps the index inside the app
   process.
3. **Elasticsearch** — Selected. Industry-standard, production-grade,
   stateless service architecture, CV keyword value, supports future scale.

The 3–4 days of additional implementation cost is justified by:
- Portfolio quality for senior-level positions
- Distributed-systems experience
- Recognized technology in the target job market (European remote)
- Operational-maturity demonstration (NestJS + Chroma + Redis + Elasticsearch,
  with Neo4j to come in Phase 3)

Constitution note: Elasticsearch sits alongside Chroma, Redis, and (Phase 3)
Neo4j as a standalone backing service that NestJS calls over HTTP — it is not a
"Python sidecar" owning LCEL/business logic, and it is not an upstream API
gateway. Architectural decision 1 is therefore honored, not overridden, so no
ADR override is required (ADR 0019 will simply document the hybrid design).

---

## Sub-phases

### Sub-Phase 4.1 — Elasticsearch Setup & Indexing (2–3 days)

Set up Elasticsearch as a service, design index mapping, and ingest all chunks.

- 4.1.1 Add Elasticsearch to Docker Compose
- 4.1.2 Design index schema (mapping definition)
- 4.1.3 Create index with proper config (analyzer, BM25 similarity settings)
- 4.1.4 Write bulk ingestion script (read from Chroma, write to ES)
- 4.1.5 Manual verification (test queries against ground truth chunks)
- 4.1.6 Documentation

### Sub-Phase 4.2 — Elasticsearch Search Service (2 days)

Build the NestJS service that queries Elasticsearch.

- 4.2.1 Install `@elastic/elasticsearch` NPM client
- 4.2.2 Create `ElasticsearchModule` and `ElasticsearchService`
- 4.2.3 Implement search method (query → top-K chunk_ids with scores)
- 4.2.4 Health check and error handling
- 4.2.5 ~~Redis cache layer for frequent queries~~ **CANCELLED (2026-06-12)** — YAGNI: the answer-level cache (`qa:v1:*`) already fronts the whole QA path, ES queries are ~10-50 ms, and the corpus is static, so a separate retrieval cache adds invalidation surface for no measurable win.
- 4.2.6 Unit and integration testing

### Sub-Phase 4.3 — RRF Fusion (1 day) — ✅ DONE (2026-06-12, commit `d543d0e`→see 4.3 commit)

Merge vector and Elasticsearch ranked lists.

- 4.3.1 ✅ `RrfFusionService` (`src/modules/fusion/`) — pure `fuse(vectorHits, keywordHits, topK=5)`, `Σ 1/(k + rank)`, dedup by `id`, deterministic tie-break (more-lists-first, then ascending id), empty-list degradation, input-immutable.
- 4.3.2 ✅ `rrf-fusion.constants.ts` — `RRF_K=60` (Cormack et al. 2009; do not tune without eval evidence), `FUSION_OUTPUT_TOP_K=5`. No env vars (algorithm constants).
- 4.3.3 ✅ 11 unit tests incl. hand-calculated exactness (`[A,B,X,C]`, scores to 1e-6) + q014 dual-list-agreement scenario. Full suite 404→415, 0 regressions.
- 4.3.4 ✅ ADR 0019 (rank-based fusion over score normalization). **Dormant until 4.4 wiring.**

### Sub-Phase 4.4 — Pipeline Integration (2 days) — ✅ DONE (2026-06-12, commit `31c5d8e`)

Connect vector + Elasticsearch + RRF into the hybrid retrieval flow.

- 4.4.1/4.4.2 ✅ `HybridRetrievalService` (`src/modules/retrieval/`) — `Promise.allSettled` parallel vector+ES (defense-in-depth on top of each service's catch), RRF fusion, symmetric degradation. `SOURCE_TOP_K=10`. Implements `IRetriever`.
- 4.4.3 ✅ `HYBRID_RETRIEVAL_ENABLED` toggle (default true), ONE seam: `RETRIEVER` token bound by `selectRetriever` factory in `QaModule`; `QaChainService` call site unchanged. env uses enum+transform (`z.coerce.boolean` maps "false"→true).
- 4.4.4 ✅ `hybrid_retrieval` structured log: `vector_hits es_hits fused_unique overlap vector_ms es_ms fusion_ms degraded`.
- 4.4.5 ✅ E2E smoke (cache flushed). **Key findings:** toggle verified (off→pure-vector, no ES log; on→hybrid). **q017/q006 ground-truth now RETRIEVED via the ES side** (overlap=0 = the vocab-mismatch signature) — but **end-to-end answers did NOT flip**: q017 retrieves `269_chunk_306` but not `307`, LLM still refuses; q006's `269_chunk_305` (ES rank #3) is squeezed out of the fused top-5 by overlap=0 + `FUSION_OUTPUT_TOP_K=5`. q002 regression answers correctly (`59_chunk_12`); q010 still refuses. **→ 4.5 must decide whether the squeeze is a topK/k tuning issue or a generation-side limit.** +9 unit tests, full suite 415→424, 0 regressions.

### Sub-Phase 4.4-E — Neighbor-Chunk Expansion (Phase 4 enhancement) — ✅ DONE (post-4.4)

Deliberate, documented scope addition driven by the **q017 read-only investigation**,
which proved the 4.4.5 "answers didn't flip" finding is an **incomplete-retrieval**
problem, not a fusion-tuning or generation problem: the answer-completing chunk
`269_chunk_307` is in NEITHER source's top-10 (no literal query terms → BM25 skips it;
vector locked onto the C++ "constructor" homonym → never surfaces ep 269), and `306`
alone ends mid-sentence. Raising `FUSION_OUTPUT_TOP_K`/`SOURCE_TOP_K`/`RRF_K` only
reorders lists that already contain the chunk — it cannot recover `307`.

- ✅ `NeighborExpansionService` (`src/modules/retrieval/neighbor-expansion.service.ts`):
  `expand(fusedChunks)` pulls each fused chunk's **±1 neighbors** by deterministic id,
  places them **adjacent to the parent in `chunk_index` order** (306→307 contiguous),
  dedup first-wins, cap `MAX_EXPANDED_CHUNKS=12` (truncate from end).
- ✅ `ChromaRepository.getByIds(ids)` — new batched exact-id fetch; ONE `get` round trip
  for all missing neighbor ids; non-existent ids silently omitted (boundary case).
- ✅ id parsing right-anchored (`/^(.+)_chunk_(\d+)$/`) — underscore/`_0`-disambiguated
  episode ids parse; neighbors never cross `episode_id`.
- ✅ Wired into `HybridRetrievalService.retrieve()` AFTER fusion; `NEIGHBOR_EXPANSION_ENABLED`
  toggle (env enum+transform bool, default true; false → fused top-K byte-identical for A/B).
  Log line extended: `expanded= chunks_before= chunks_after= neighbors_added=`.
- ✅ Neighbor `score=0` sentinel (context, not ranked). Chroma-error → degrade to
  un-expanded list (WARN `neighbor_fetch_failed`).
- ✅ +12 `NeighborExpansionService` tests (incl. the 306→307 adjacency proof) + 2
  `HybridRetrievalService` wiring tests. Full suite **424 → 438, 0 regressions**, build clean.
- ✅ ADR 0019 — "Neighbor-Chunk Expansion" section; architectural decision 23 in CLAUDE.md.
- ⏸️ **Smoke test deferred** to a separate follow-up prompt — NOT yet run end-to-end
  against the live LLM. 4.5 eval will measure the expansion's isolated effect via the toggle.

### Sub-Phase 4.5 — Evaluation (1–2 days)

Run new baseline and compare to `baseline-2026-06-07`.

- 4.5.1 Pre-run checklist
- 4.5.2 Execute full eval
- 4.5.3 Save new baseline (`baseline-hybrid-YYYY-MM-DD/`)
- 4.5.4 Side-by-side comparison report
- 4.5.5 Analyze the 4 failing questions (q006, q012, q014, q017)
- 4.5.6 Regression check
- 4.5.7 Tuning iteration if needed

### Sub-Phase 4.6 — Documentation & Closure (1–2 days)

- 4.6.1 ADR 0019: Hybrid Retrieval with Elasticsearch
- 4.6.2 Update `evaluation/README.md`
- 4.6.3 Update main project `README.md`
- 4.6.4 CLAUDE.md Phase 4 closure
- 4.6.5 LinkedIn post draft

**Total estimated duration: 9–12 days (about 2 weeks)**

---

## Tech Stack Decisions

1. **BM25 implementation:** Elasticsearch (latest stable version)
   - Reason: industry-standard, production-grade, distributed search engine with
     native Okapi BM25 similarity; stateless service that scales independently
     of the app process.
   - Alternatives considered & rejected: Python FastAPI + `rank_bm25` (violates
     the single-NestJS-service decision); TypeScript in-process
     `wink-bm25-text-search` (works at current scale but signals a quick fix,
     keeps the index inside the app process). See "Rationale for Elasticsearch"
     above.

2. **NPM client:** `@elastic/elasticsearch` (installed in 4.2.1, not before)

3. **Tokenization:** Elasticsearch built-in analyzers — the `standard` analyzer
   with English stopwords. Index-time and query-time analysis are configured on
   the same field, so the build-vs-query tokenizer-consistency risk that the
   in-process approach carried is handled by ES itself.

4. **Index storage:** Elasticsearch manages persistence internally (its own
   on-disk Lucene segments inside the ES container's volume). No pickle file,
   no `data/bm25/` directory.

5. **Service architecture:** Elasticsearch runs as a Docker Compose service
   alongside Chroma and Redis; NestJS calls it over HTTP via the official
   client. This is the same backing-service pattern the project already uses —
   CLAUDE.md architectural decision 1 ("single NestJS service / no Python
   sidecar") is honored, not overridden.

---

## Success Criteria

- Hit@5 ≥ 0.92
- Faithfulness ≥ 0.82
- Context Recall ≥ 0.85
- At least 3 of the 4 failing questions now return Hit@5 > 0
- No regression below threshold on currently-passing questions
- End-to-end retrieval latency under 1.5 seconds

---

## Related ADRs

- ADR 0003 — Vector store module and retrieval (the vector half of the hybrid)
- ADR 0017 — RAG Evaluation Framework (Phase 2 closure; defines the baseline)
- ADR 0019 — Hybrid Retrieval with Elasticsearch (to be written in 4.6.1)

## Documentation Touchpoints (at closure)

- ADR 0019 (new)
- `evaluation/README.md`
- Main project `README.md`
- CLAUDE.md (Phase 4 closure)
