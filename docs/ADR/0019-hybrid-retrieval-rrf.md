# ADR 0019 — Hybrid retrieval fusion via Reciprocal Rank Fusion (RRF)

- **Status:** Accepted
- **Date:** 2026-06-12
- **Phase:** 4 — Hybrid Retrieval, Sub-Phase 4.3
- **Related:** ADR 0018 (Elasticsearch keyword service — the source of the keyword list and the BM25-vs-cosine score-scale finding), ADR 0003 (vector retrieval — the source of the vector list and the `RetrievedChunk` type), ADR 0017 (evaluation — the baseline the fused pipeline will be measured against in 4.5)

---

## Context

Phase 4 retrieves from two stores with complementary strengths: Chroma (vector,
semantic) and Elasticsearch (BM25, exact/rare terminology). We need to merge
their two ranked lists into one list the LLM can consume.

The hard constraint comes from 4.2: **the two score scales are incomparable.**
The vector side's `score` is a cosine similarity in `[0, 1]`; the keyword side's
is a raw BM25 score — unbounded, ~12–28 in practice. A chunk scoring 0.82
(vector) and a chunk scoring 22 (BM25) cannot be ordered by score magnitude.

The 4.1.5 smoke tests quantified what fusion must achieve on the 4 zero-hit
baseline questions: BM25 alone ranks the ground-truth chunk #1 for q017 and #3
for q006 (keyword wins), misses q012 entirely (vector must carry it), and puts
q014 at #8 — outside top-5 but present, the case where **agreement between both
lists** should lift it.

## Decision

### 1. Rank-based fusion: RRF with k = 60

`RRF_score(chunk) = Σ over lists [ 1 / (k + rank) ]`, rank 1-based per list,
`k = 60` (the standard constant from Cormack, Clarke & Büttcher, SIGIR 2009).
Fusion uses **rank position only** — raw cosine/BM25 scores are consumed by
ranking and never compared or carried forward. The fused result's `score` field
becomes the RRF score; output defaults to top-5 (what the LLM receives), inputs
are top-10 from each side (4.4's concern).

Dedup is by `id` (the bridge key identical across both stores). A chunk in both
lists sums its two contributions — this is precisely the dual-list-agreement
boost that rescues q014. A chunk in one list gets only that list's contribution,
so the degradation path (ES down → empty keyword list, ADR 0018) reduces cleanly
to "vector order, RRF-rescored" with no special-casing.

Tie-break (exactly-equal RRF scores) is deterministic: more lists first, then
ascending lexicographic `id`. (Equal score with unequal list-count is essentially
unreachable with integer ranks — the rule is defensive.)

### 2. Pure function, algorithm constants not env vars

`RrfFusionService.fuse()` is pure: no I/O, no async, no state, no mutation of
inputs — same input always yields the same output. `RRF_K` and
`FUSION_OUTPUT_TOP_K` are code constants, NOT env vars: changing them changes
ranking behaviour and must be justified by 4.5 evaluation evidence, not a
deployment knob.

## Alternatives rejected

- **Score averaging / weighted linear combination** (`α·cosine + β·BM25`):
  scale-broken — cosine maxes at 1, BM25 has no ceiling, so BM25 dominates any
  un-normalized sum, and a weighted blend needs `α/β` tuning data we do not have
  (and could only get from the very eval we are trying to improve).
- **Min-max normalization then average:** normalizes each list's scores into
  `[0, 1]` per query. Rejected for per-query range instability — the min and max
  shift every query, so the same chunk's normalized score is not comparable
  across queries, and a single outlier score warps the whole list. RRF sidesteps
  this entirely by never touching score magnitude.

## Expected effect on the 4 failing questions

- **q017, q006** — carried by BM25 (ground-truth at rank #1 / #3 on the keyword
  side); RRF surfaces them via the keyword list's top contributions.
- **q012** — carried by the vector side (no distinctive keyword term; BM25 missed
  it); RRF preserves the vector ranking.
- **q014** — at BM25 #8 and present in the vector list too; the summed
  dual-list contribution should lift it into the fused top-5 — the canonical
  reason to fuse rather than pick one retriever.

Magnitudes (the q014 rescue): a chunk at keyword #8 + vector #6 scores
`1/68 + 1/66 ≈ 0.0299`, beating a single-list chunk at rank #2 (`1/62 ≈ 0.0161`).
These are the actual numbers asserted in the unit tests.

## Consequences

- **Positive:** fusion is parameter-free (one constant, evidence-gated),
  scale-robust, and degradation-compatible by construction; pure → trivially
  testable with hand-calculated exact assertions.
- **Negative / accepted:** RRF discards score magnitude, so a vector hit that is
  *vastly* more similar than the rest gets no extra credit beyond its rank —
  acceptable, and the 4.5 eval will confirm or challenge it.
- **Tested:** 11 unit tests — hand-calculated exactness (`[A,B,X,C]` with scores
  to 1e-6), the q014 dual-list-agreement scenario, both degradation paths, dedup,
  topK, deterministic tie-break, RRF-score output, input immutability.
- **Dormant:** nothing calls `fuse()` until the pipeline wiring in 4.4.

---

## Neighbor-Chunk Expansion (post-fusion context completion)

### Problem

The 4.4 smoke test and the follow-up q017 investigation (read-only) found a
failure mode that **no fusion tuning can fix**. For q017 ("What does Lee Cronin
mean when he distinguishes constructors from abstractors?"), RRF correctly
surfaces the on-topic chunk `269_chunk_306` at the top of the fused list — but
the chunk that *completes the answer* never enters the pipeline:

- `269_chunk_306` ends mid-sentence: "…the abstractor is the ability of Alan
  Turing and Gödel and Church… to come up with **a set of axioms**" — and stops.
- `269_chunk_307` finishes it ("…to basically understand the universe
  mathematically… **Where is the prime labeler?**") — the exact payoff the
  ground-truth answer needs.
- `307` is retrieved by **neither** source: it carries none of the query's
  literal terms ("constructor"/"abstractor"), so BM25 ranks it nowhere in its
  top-10; and the vector side locked onto the C++ "constructor/destructor"
  homonym (episode 48, Stroustrup), so it never surfaces episode 269 at all.

A chunk that is in **neither source's top-10** cannot be recovered by raising
`FUSION_OUTPUT_TOP_K`, raising `SOURCE_TOP_K`, or changing `RRF_K` — those knobs
only reorder or deepen lists that already contain the chunk. The LLM, handed one
partial chunk (`306`) plus four distractors (two of them the C++ homonym),
correctly refused: *"I cannot answer this question from the provided sources."*
This is an **incomplete-retrieval** problem, not a fusion or generation defect.

### Decision

After fusion, expand each surviving chunk with its **±1 neighbors** by
deterministic id (`{episode_id}_chunk_{index}`) and place them **adjacent to
their parent in `chunk_index` order**, so a sentence split across a chunk
boundary (`306|307`) is reassembled contiguously for the LLM. Implemented as
`NeighborExpansionService` (`src/modules/retrieval/`), called inside
`HybridRetrievalService.retrieve()` after `RrfFusionService.fuse()` and before
returning.

- **Window ±1** (`NEIGHBOR_WINDOW = 1`), not ±2 — the split is always between
  immediate neighbors; ±2 doubles context noise for marginal gain.
- **Applied to all fused chunks** — we don't know in advance which parent owns
  the boundary.
- **Single batched Chroma fetch** — all needed neighbor ids are computed up
  front, deduped, and the *missing* ones (parents are already in hand) are
  fetched in ONE `ChromaRepository.getByIds()` call (new method), never per
  chunk. Non-existent ids (episode boundary, gaps) are silently omitted by
  Chroma and skipped.
- **id parsing is right-anchored** (`/^(.+)_chunk_(\d+)$/`) so episode ids that
  themselves contain underscores — including the `_0`/`_1`
  collision-disambiguation suffixes from `prepare_dataset.py` (`14_0_chunk_5`) —
  parse correctly; neighbors are computed within one episode only, never across
  an `episode_id` boundary.
- **Cap `MAX_EXPANDED_CHUNKS = 12`** — truncated from the end (highest-rank
  groups survive) so context size stays bounded (worst case 5×3 = 15 → 12).
- **Neighbor score = 0 sentinel** — neighbors are *context*, not ranked hits;
  0 (vs. inheriting the parent's RRF score) makes that unambiguous. Downstream
  `formatContext` orders by array position, not score, so the sentinel is inert
  in the prompt.

### Ordering guarantee

Fusion rank is the primary order. Each parent emits a group
`[prev?, parent, next?]` in `chunk_index` order; groups are concatenated in
fusion-rank order; the sequence is deduped by id (first occurrence wins) then
capped. This guarantees **306 is immediately followed by 307** in the final
context — proven by the `NeighborExpansionService` "split-sentence ordering"
unit test (`expect(i307).toBe(i306 + 1)`).

### Toggle (A/B eval seam)

`NEIGHBOR_EXPANSION_ENABLED` (env, enum+transform boolean — same `z.coerce`
footgun avoidance as `HYBRID_RETRIEVAL_ENABLED`, default **true**). False → the
fused top-K passes through byte-identical, so 4.5 can measure the expansion's
isolated effect. The `hybrid_retrieval` log line gains
`expanded=<bool> chunks_before=<n> chunks_after=<n> neighbors_added=<n>`.

### Resilience

A Chroma fetch error inside expansion degrades to the **un-expanded fused list**
(WARN `neighbor_fetch_failed`) — an auxiliary context layer must never fail a
request.

### Consequences

- **Positive:** recovers boundary-split answers (q017's `307`) that are
  unreachable by any retriever tuning; deterministic; one extra batched Chroma
  read (~exact-id `get`, cheap); fully behind a default-on toggle for clean A/B.
- **Negative / accepted:** adds up to 7 context chunks (12 vs. 5) → larger
  prompt; a real eval (4.5) will confirm the faithfulness/recall gain outweighs
  the added context. Expansion adds a Chroma dependency to the hybrid path even
  when the vector side itself failed — mitigated by the fail-open degrade.
- **Tested:** 12 `NeighborExpansionService` unit tests (basic ±1, split-sentence
  adjacency proof, dedup first-wins, max-12 cap truncate-from-end, first/last
  chunk boundaries, absent-neighbor skip, cross-episode safety, underscore
  episode-id parsing, single-batched-fetch, graceful Chroma-error degrade, empty
  input) + 2 `HybridRetrievalService` wiring tests (toggle off → not called /
  returned as-is; toggle on → called, result returned, log fields). Full suite
  424 → 438, 0 regressions.
- **Smoke test:** deferred to a separate follow-up (not part of this change).
