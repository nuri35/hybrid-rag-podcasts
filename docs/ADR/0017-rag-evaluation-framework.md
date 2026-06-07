# ADR 0017 — RAG evaluation framework

- **Status:** Accepted
- **Date:** 2026-06-07
- **Phase:** 2 — Sprint Eval-RAG-Core
- **Related:** ADR 0007 (QA chain — the system under evaluation), ADR 0013 (prompt-security — refusal-detection patterns are aligned with the output-validation pattern family; the multi-source citation regex fix shipped during this sprint), ADR 0003 (retrieval — the chunk IDs the deterministic metrics match against)

---

## Context

Phase 1 shipped a working vector RAG pipeline, and every assessment of its
quality so far has been subjective ("the answer looks right"). Before building
the graph layer (Phase 3) and hybrid retrieval (Phase 4), we need a number
that says how good the system actually is — and, when it isn't, **which
layer** is at fault. CLAUDE.md's foundation answers set explicit targets
(faithfulness > 0.9, context precision > 0.7, context recall > 0.8) that were
unmeasurable until now.

Open questions this ADR settles: which metric set, which tooling, how results
are interpreted, and how the evaluation stays affordable on a free-tier Gemini
quota.

## Decision

### 1. Two-layer evaluation model with a diagnostic map

Retrieval and generation are measured as separate layers. The pair
(Context Recall, Faithfulness) forms a 2×2 map: both low → fix retrieval
first; recall low / faithfulness high → retrieval problem; recall high /
faithfulness low → generation (hallucination) problem; both high → healthy.
`diagnosis.py` encodes the map plus per-layer drill-downs and emits findings
with severities (HEALTHY/INFO/WARNING/CRITICAL) and suggested actions.

*Alternatives considered:* a single composite score (rejected — hides which
layer is broken, so it can't guide a fix); more than two layers (rejected —
no third subsystem exists yet; revisit when routing/Phase 5 lands).

### 2. Ragas for semantic metrics

Faithfulness, Answer Relevancy, and Context Recall come from Ragas 0.2.6 with
`gemini-2.5-pro` as LLM judge (temperature 0) and `gemini-embedding-001` for
similarity. Ragas is the most mature open-source option, its metric
definitions are industry vocabulary, and its LangChain wrappers let us plug in
the Gemini judge.

*Alternatives considered:* TruLens (nice dashboards, less standard metrics),
DeepEval (pytest-centric, wrong shape for a standalone CLI harness), ARES
(needs per-domain classifier training), LangSmith (hosted/paid), fully custom
LLM-as-judge (maximum control but reinvents standard metrics — deferred).

*Note:* CLAUDE.md originally projected "Ragas-equivalent metrics via
LangChain.js evaluation tools". We chose real Python Ragas instead: the JS
evaluation ecosystem has no Faithfulness/Context Recall equivalents of
comparable maturity. The evaluation harness is dev-time tooling, so the
no-Python-in-production rule is not violated (same carve-out as
`scripts/prepare_dataset.py`).

### 3. Three Ragas metrics, not five

Context Precision and Answer Correctness were trimmed mid-sprint:

- Context Precision is the most LLM-expensive Ragas metric (~5 calls/question)
  and overlaps what deterministic Precision@5 + MRR already signal for free.
- Answer Correctness largely duplicates Faithfulness + Context Recall +
  Answer Relevancy and is highly sensitive to ground-truth phrasing.
- Net saving ≈ 40 % of judge calls per run (~375 → ~225), which matters on a
  1000-requests/day free-tier quota.

They can return behind a `--full-metrics` flag if a future phase needs them.

### 4. Custom deterministic retrieval metrics

MRR, Hit@5, Precision@5, Recall@5 are computed by exact chunk-ID matching
against the golden dataset (`retrieval_metrics.py`) — no LLM involvement.
Deterministic, free, instant, and the formulas are industry-standard. This is
also why dropping Ragas Context Precision (decision 3) loses little signal.

### 5. Golden dataset: 25 questions, 3 categories

10 factual_lookup (easy) + 10 multi_source (medium) + 5 edge_case = 25,
hand-built from real chunk content with ground-truth answers and chunk IDs.
25 gives enough signal to compare runs and spot per-category patterns while
keeping a full run inside the daily quota. Edge cases exist because refusing
on unanswerable questions is part of the product contract (CLAUDE.md Q1:
"never hallucinate"); 4 of 5 are refusal-expected.

### 6. Full chunk text (not excerpts) in Ragas contexts

`build_ragas_dataset()` fetches full chunk text from Chroma for the judge's
`contexts`; the API's 200-char `Source.excerpt` is only a fallback when
Chroma is unreachable. This decision came from a measured failure — see
"Excerpt Artifact Discovery" below. The lookup also self-clears
`SSL_CERT_FILE`-family env vars for its duration (an unreadable cert path
breaks httpx before any request; plain HTTP to localhost needs no CA bundle).

### 7. Pattern-based refusal compliance (no LLM judge)

`refusal_metric.py` detects refusal-shaped answers with a regex family
deliberately aligned with the production output-validation patterns
(ADR 0013), and scores `correctly_refused / total_refusal_questions`.
Deterministic, fast, free. Known limitation: a paraphrased refusal outside
the pattern family goes undetected; an LLM judge can be added later if that
ever happens in practice.

## Excerpt Artifact Discovery — process documentation

Worth recording because the *process* is the lesson.

**Initial baseline (2026-06-06):** Faithfulness 0.292 → diagnostic verdict
CRITICAL, "generation is hallucinating".

**The doubt:** on visual inspection the answers looked correct — citations
present, some answers near-verbatim quotes of the retrieved chunks. A
hallucination score of 0.000 on a verbatim quote is not plausible.

**Manual audit:** the 4 worst questions (q002/q008/q011/q022, all
Faithfulness = 0.000) were dumped with their FULL chunk texts from Chroma
(`results/baseline-2026-06-06/faithfulness-audit.md`) and compared
claim-by-claim. Result: 4/4 answers fully supported by the chunks.

**Hypothesis:** the judge sees `Source.excerpt` — a 200-char snippet — as
context. The snippet doesn't contain the supporting evidence, so the judge
correctly concludes "unsupported" about an answer that the full chunk
supports. The metric was measuring our plumbing, not the system.

**Controlled test:** `run_faithfulness_test.py` replayed the same 4 questions
through Ragas twice — excerpts vs full chunks. Faithfulness 0.000 → 0.927
(Context Recall 0.000 → 1.000; Answer Relevancy unchanged, as expected since
it barely uses contexts — a clean internal control). Hypothesis confirmed.

**Fix:** decision 6 above. The clean 2026-06-07 baseline then measured
Faithfulness 0.768 with full 25/25 coverage.

**Lessons:**
- Before fixing the system, question the metric. The CRITICAL verdict would
  have sent us tightening prompts that were never broken.
- An LLM judge needs sufficient context to judge; feeding it truncated
  evidence produces confident false negatives.
- A cheap manual audit (4 questions, one hour) prevented a wrong-direction
  sprint.

## Consequences

### Positive

- System health is now a measured, reproducible number; baselines are
  diffable JSON.
- The 2×2 map turns a bad score into a located problem with suggested actions.
- Deterministic retrieval metrics give a free, instant signal independent of
  any judge.
- Refusal compliance (1.000 at baseline) is finally proven, not assumed.

### Negative

- Gemini dependency: `gemini-2.5-pro` free tier allows 1000 requests/day; a
  full run consumes ~400–600, so effectively one full eval per day. Quota
  exhaustion mid-run silently degrades coverage — always check
  `questions_evaluated_for_faithfulness` ≈ 25 in baseline.json.
- Full run takes ~5–15 minutes (up to ~25 under throttling).
- 4 questions (q006, q012, q014, q017) retrieve zero relevant chunks —
  a vector-only limitation deferred to Phase 4 hybrid retrieval.

### Neutral

- Judge self-preference bias is possible (judge and production LLM are both
  Gemini family).
- 25 questions is directional, not statistically significant for small deltas.
- Answer Relevancy aggregate (0.589) is structurally deflated by
  refusal-shaped answers scoring ~0; read it per-question.

## Baseline (2026-06-07, clean)

MRR 0.712 · Hit@5 0.810 · Precision@5 0.248 · Recall@5 0.786 ·
Faithfulness 0.768 · Answer Relevancy 0.589 · Context Recall 0.767 ·
Refusal 1.000 (4/4) · Overall: WARNING (relevancy deflation + precision INFO).

## References

- Operational guide: `evaluation/README.md`
- Ragas documentation: https://docs.ragas.io/
- Baseline reports: `evaluation/results/baseline-2026-06-07/`
- Audit artifacts: `evaluation/results/baseline-2026-06-06/faithfulness-audit.md`,
  `evaluation/run_faithfulness_test.py`
