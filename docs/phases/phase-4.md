# Phase 4 — Hybrid Retrieval (BM25 + RRF)

**Status:** 🟡 In progress
**Started:** 2026-06-10
**Estimated completion:** 9–13 days (~2 weeks)
**Baseline to beat:** `evaluation/results/baseline-2026-06-07/`

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
- BM25 keyword search using `rank_bm25`
- RRF (Reciprocal Rank Fusion) to merge vector + BM25 rankings
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

## Sub-phases

### 4.1 — Build BM25 Index (2–3 days)
Build a searchable BM25 index of all chunks, saved to disk.
- 4.1.1 Install `rank_bm25` library ← **current step**
- 4.1.2 Build tokenizer function (shared by index + query)
- 4.1.3 Write index build script
- 4.1.4 Save index to disk (`data/bm25/index.pkl`)
- 4.1.5 Manual verification (query the 4 failing questions' terms, confirm hits)
- 4.1.6 Documentation

### 4.2 — BM25 Retrieval Service (2–3 days)
Make the BM25 index callable from the system.
- 4.2.1 Decide service location — **see "Open architectural question" below**
- 4.2.2 Build the service
- 4.2.3 Add to Docker Compose (if a separate service)
- 4.2.4 NestJS client
- 4.2.5 Caching layer (Redis)
- 4.2.6 Testing

### 4.3 — RRF Fusion (1 day)
Combine vector and BM25 results into one ranked list.
- 4.3.1 Implement RRF formula (`score = Σ 1/(k + rank_i)`, default k=60)
- 4.3.2 Configuration (k constant, per-retriever weighting if any)
- 4.3.3 Unit testing
- 4.3.4 Documentation

### 4.4 — Pipeline Integration (2 days)
Connect vector + BM25 + RRF into a single hybrid flow.
- 4.4.1 New `HybridRetrievalService`
- 4.4.2 Update the QA/retrieval service to use it
- 4.4.3 Logging additions (per-retriever hit counts, fused order)
- 4.4.4 Smoke testing

### 4.5 — Evaluation (1–2 days)
Measure improvement against `baseline-2026-06-07`.
- 4.5.1 Pre-run checklist (Gemini quota, services up, cache flush)
- 4.5.2 Execute eval
- 4.5.3 Compare results
- 4.5.4 Investigate any regressions
- 4.5.5 Tuning iteration if needed (RRF k, candidate-set sizes)

### 4.6 — Documentation and Closure (1–2 days)
- 4.6.1 ADR 0019 (hybrid retrieval architecture)
- 4.6.2 Update `evaluation/README.md`
- 4.6.3 Update main project `README.md`
- 4.6.4 Update CLAUDE.md (Phase 4 closure)
- 4.6.5 LinkedIn post draft

---

## Tech Stack Decisions

1. **BM25 library:** `rank_bm25==0.2.2` (Python)
   - Reason: simple, well-tested, fits our chunk scale (~53k chunks comfortably in memory)
   - Alternatives considered: Elasticsearch (operational overkill for a portfolio project), custom implementation (slow to deliver, easy to get TF-IDF weighting subtly wrong)

2. **Tokenization strategy:**
   - Lowercase → remove punctuation → remove English stopwords → no stemming
   - The SAME tokenizer must run at index-build time and query time — a mismatch silently tanks recall. This is the single most important consistency invariant in 4.1/4.2.
   - Open detail for 4.1.2: source of the stopword list (small hardcoded set vs a library) — to avoid pulling in a heavy NLP dependency for one list.

3. **Index storage:**
   - Pickle file at `data/bm25/index.pkl`
   - Manual rebuild via script; no auto-rebuild on startup
   - `data/bm25/` should be gitignored like other generated data

4. **Service architecture (UNRESOLVED — see below):**
   - Tentatively proposed: Python FastAPI microservice, called by NestJS over HTTP
   - To be confirmed in Sub-Phase 4.2

### ⚠ Open architectural question (4.2.1) — constitution conflict

The tentative "Python FastAPI microservice" **conflicts with two locked items
in CLAUDE.md**:

- **Architectural decision 1:** "Single NestJS service. No Python sidecar, no
  upstream API gateway… A Python service would dilute the AI engineering
  narrative and add operational complexity for no learning gain."
- **Hard constraint (DO NOT):** "Suggest FastAPI, LangServe, Flask, or any
  Python web framework."

These were deliberate, ADR-worthy decisions. Two honest resolutions exist, to
be chosen in 4.2:

1. **Honour the constitution:** implement BM25 in TypeScript (e.g. an
   in-process Node BM25 such as `wink-bm25-text-search`, or a hand-rolled
   Okapi BM25 over the chunk corpus). Keeps "single NestJS service" intact;
   the index could still be built by a one-off Python/TS script. **Note:** the
   `rank_bm25`/pickle decisions in section 1–3 are themselves part of the
   Python-path assumption; choosing the TS path revisits them.
2. **Override the constitution:** write an ADR that explicitly supersedes
   decision 1 for this case, arguing the trade-off (reuse of the mature
   `rank_bm25`, the index build already being Python-side via the eval/data
   tooling). Only then is the Python sidecar sanctioned.

Until 4.2 decides, the Python sidecar is **not approved**, and the
`rank_bm25` install in 4.1.1 is justified for **dev-time index building and
experimentation** (the same dev-time Python carve-out as `scripts/` and
`evaluation/`), not as a committed production-runtime dependency.

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
- ADR 0019 — Hybrid Retrieval Architecture (to be written in 4.6.1)

## Documentation Touchpoints (at closure)

- ADR 0019 (new)
- `evaluation/README.md`
- Main project `README.md`
- CLAUDE.md (Phase 4 closure)
