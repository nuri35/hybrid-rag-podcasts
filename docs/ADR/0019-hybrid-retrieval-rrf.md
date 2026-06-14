# ADR 0019 — Hybrid retrieval: vector + Elasticsearch BM25 + RRF fusion + ±1 neighbor expansion

- **Status:** Accepted (Phase 4 complete, 2026-06-14)
- **Date:** 2026-06-12 (RRF); extended through 2026-06-14 (neighbor expansion, citation fix, eval methodology, final results, closure)
- **Phase:** 4 — Hybrid Retrieval (sub-phases 4.3 RRF → 4.4 integration → 4.4-E neighbor expansion → 4.5 evaluation → 4.6 closure)
- **Related:** ADR 0018 (Elasticsearch keyword service — the source of the keyword list and the BM25-vs-cosine score-scale finding), ADR 0003 (vector retrieval — the source of the vector list and the `RetrievedChunk` type), ADR 0017 (evaluation — the baseline the fused pipeline is measured against)

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

---

## Citation-validator loosening (post-4.4 fix)

The smoke + 4.5 eval surfaced two HTTP 500s (q007, q024) under the expanded
context. A **deterministic 20-run investigation** (expansion ON: 0/10 pass; OFF:
10/10 pass; byte-identical at temperature 0) found the cause: under a larger
multi-source context (9–11 chunks) the LLM **abbreviates its citations** from
`[Source N]` to bare `[N]` (e.g. `[2, 3]`, `[5, 9]`). The answers are fully
grounded and DO cite — only the marker format differs — but the output-validation
regex required the literal `Source` token, so it rejected them as
`missing_citation` → 500.

**Decision:** loosen the citation regex to accept both forms —
`/\[\s*(?:Source\s+)?\d+(?:\s*,\s*(?:Source\s+)?\d+)*\s*\]/i`. It is a superset
of the old pattern (existing `[Source N]` answers still pass; digitless brackets
`[]`/`[Source]`/`[abc]` still fail), so it carries **zero risk to the fixed
questions** (q014/q017 emit `[Source N]`). Hypothesis: expansion-induced format
abbreviation; LLM nondeterminism ruled out (temp-0 determinism); episode-294
structural cause ruled out (same chunks cite correctly with 5 chunks). See the
`OutputValidationService` comment for the regex rationale.

## Eval methodology — rank metrics over the fused list, generation over expanded

Neighbor expansion prepends ±1 neighbors (score 0) **adjacent to their parent**
for sentence-completion, which deliberately reorders the returned list. The 4.5
eval scored rank metrics over that reordered list, so a ground-truth chunk that
was rank-1 in the fused list read as rank-2 behind its own prepended neighbor —
producing **false** MRR/Hit@5 "regressions" (MRR 0.712→0.389) even though no
ground-truth chunk was actually lost.

**Decision — measure each metric where it belongs:**
- **Rank metrics** (MRR/Hit@5/Precision@5/Recall@5) → the **fused top-5
  BEFORE expansion** (the retrieval system's true ranked list), surfaced as
  `retrievalMetadata.fusedTopK` in the QA response via an optional
  `captureFusedTopK` observer callback on `RetrievalOptions` (no change to
  `retrieve()`'s return type or the LLM context).
- **Generation metrics** (Faithfulness/Context Recall/Answer Relevancy) → the
  **expanded context** (`sources`), i.e. what the LLM actually saw.
- **Generation aggregates split substantive vs refusal** — Ragas scores
  refusal-shaped answers erratically (0 or 1 by construction), which deflates
  the raw mean; the substantive (non-refusal) figure is the honest signal.

`baseline-2026-06-07` is untouched; the comparison stays apples-to-apples (both
the old and new rank metrics measure "retrieval's final ranked list").

## Final results (2026-06-14, `evaluation/results/baseline-hybrid-final-2026-06-14/`)

Single clean run, hybrid + ±1 expansion ON, corrected harness, 25/25 successful.

| Metric | Baseline (vector-only) | Final (hybrid+expansion) | Δ |
|---|---|---|---|
| Hit@5 | 0.810 | **0.905** | +0.095 |
| MRR | 0.712 | **0.774** | +0.062 |
| Precision@5 | 0.248 | **0.267** | +0.019 |
| Recall@5 | 0.786 | **0.841** | +0.055 |
| Context Recall | 0.767 | **0.900** | +0.133 |
| Faithfulness (substantive) | ~0.841 | **0.905** | +0.064 |
| Faithfulness (raw) | 0.768 | 0.728 | −0.040 (refusal-deflated, documented) |
| Answer Relevancy (substantive) | — | 0.831 | — |
| Refusal Compliance | 1.000 | 1.000 | = |

Regression check: **2 improved (q014, q017), 19 unchanged, 0 regressed** — no
ground-truth chunk dropped at retrieval. The 4.5 raw "regressions" (MRR 0.389,
Hit@5 0.762) were confirmed as the measurement artifact above and are fully
recovered.

## Intentionally out of scope (documented misses, not gaps)

Of the 4 original zero-hit questions, **2 were fixed** (q014 via RRF dual-list
lift + expansion completing the 14/15 pair; q017 via expansion pulling 307
adjacent to 306). The remaining **2 are deliberate scope decisions**, each with a
measured root cause:

- **q006** — *coverage gap.* Ground truth `269_chunk_305` sits at **fused rank 6**
  (just below the top-5 cut, losing a lexicographic tie) and is **+3 from the
  nearest surviving fused chunk**, beyond the ±1 expansion window. Root cause:
  BM25's rare-name IDF ranks the name-rich setup chunks (`301`/`302`, which
  mention "Lee Cronin" 3×) above the actual answer chunk `305` (where Cronin is
  the speaker and never names himself), while the vector side misses episode 269
  entirely. The minimal fix (`FUSION_OUTPUT_TOP_K 5→6` **and**
  `MAX_EXPANDED_CHUNKS 12→≥13`, a coordinated two-knob change) carries a
  measurable faithfulness risk to q017 (it admits more episode-48 C++-homonym
  context) — **not worth it for one question.** q006 already produces a faithful
  answer (0.91) from adjacent chunks.
- **q012** — *vector-embedding limitation.* Ground truth `59_chunk_4/5` is
  **invisible to both retrievers**: the question's terms ("human walking",
  "machine learning") are common, giving BM25 no rare anchor, and the vector side
  never places episode 59 near the query. No fusion or ±1 expansion can recover a
  chunk neither retriever surfaces; the system correctly **refuses** rather than
  hallucinating.

**Deferred future options** (a separate enhancement sprint, not Phase 4): a
cross-encoder **reranker** over a wider candidate pool (could lift q006's `305`),
**query rewriting / HyDE** (could give q012 a better embedding match), or
**stronger embeddings**. All add latency/cost and were judged out of scope for
the Phase 4 deliverable, whose goal — keyword retrieval to fix vocabulary-mismatch
failures — is met.

## Status — Phase 4 closed

Hybrid retrieval (vector + Elasticsearch BM25 + RRF + ±1 neighbor expansion) is
the live default path. No reranker (deferred). Phase 4 is complete; see
`evaluation/README.md` for the full eval breakdown and CLAUDE.md decisions 20–23
for the architectural record.
