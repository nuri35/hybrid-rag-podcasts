# RAG Evaluation Framework

This directory contains the Phase 2 evaluation harness for the hybrid-rag-podcasts
system. It measures, with numbers instead of impressions, how well the RAG pipeline
answers questions about podcast transcripts: does retrieval bring back the right
chunks, does the LLM stay faithful to them, and does the system refuse when the
sources genuinely don't contain an answer.

The framework runs a 25-question golden dataset against the live NestJS API,
computes deterministic retrieval metrics plus LLM-as-judge generation metrics
(Ragas + Gemini), applies a diagnostic map that tells you **which layer** is
broken and **what to do about it**, and writes both a human-readable markdown
report and a machine-diffable JSON report.

It is dev-time tooling, written in Python. Production code remains TypeScript-only
(see CLAUDE.md, architectural decision 1); like `scripts/prepare_dataset.py`, this
directory is a sanctioned dev-time Python area, never a runtime dependency.

> Architecture decisions and their rationale live in
> [ADR 0017](../docs/ADR/0017-rag-evaluation-framework.md). This README is the
> operational guide.

## Quick Start

```powershell
# Prerequisites: docker-compose up (Chroma + Redis), NestJS API on :3000,
# GOOGLE_API_KEY in .env, venv with requirements-eval.txt installed.

.\.venv\Scripts\python.exe -X utf8 -u evaluation/run_eval.py
```

- **Runtime:** typically 5–15 minutes; up to ~25 under heavy Gemini Tier-1
  throttling. The Ragas phase dominates (query phase is ~2 minutes).
- **Output:** `evaluation/results/baseline-{YYYY-MM-DD}/baseline.md` + `baseline.json`
- **Smoke test first:** `--max-questions 3` runs in ~2 minutes and validates the
  whole pipeline before you spend quota on a full run.

Useful flags: `--skip-cache-flush` (dev iterations), `--output <dir>`,
`--api-base <url>`, `--max-questions N`.

## Architecture Overview

```
golden-dataset.json (25 Q)        NestJS API (localhost:3000)
        │                                  │
        ▼                                  │
   dataset.py ──── questions ──► api_client.py ── POST /api/v1/questions
                                           │
                                    QueryResults (answer + 5 chunk IDs)
                                           │
        ┌──────────────────┬───────────────┼────────────────────┐
        ▼                  ▼               ▼                    │
retrieval_metrics.py  refusal_metric.py  generation_metrics.py  │
(MRR/Hit/Prec/Recall, (pattern-based,    (Ragas + Gemini judge; │
 deterministic)        deterministic)     full chunk text from  │
        │                  │              Chroma)               │
        └──────────────────┴───────┬──────┘                     │
                                   ▼                            ▼
                             diagnosis.py ──────────────► report.py
                          (layer map + drill-down)    (baseline.md + .json)
```

Everything is orchestrated by `run_eval.py` in 9 stages (see
[Running an Evaluation](#running-an-evaluation)).

## Two-Layer Diagnostic Model

### Why two layers?

A RAG system is two machines bolted together: **retrieval** (find the right
text) and **generation** (answer from that text without inventing anything).
They fail differently and they are fixed differently — more top-K helps a
retrieval problem and does nothing for a hallucinating LLM. A single composite
score hides which machine is broken; two layers point at the repair site.

### General metrics (layer-level diagnosis)

| Metric | What it measures | Healthy |
|---|---|---|
| Context Recall (Ragas) | Did retrieval bring enough information to support the ground-truth answer? | > 0.7 |
| Faithfulness (Ragas) | Is every claim in the answer supported by the retrieved context? | > 0.7 |

### The 2×2 diagnostic map

| | Faithfulness LOW | Faithfulness HIGH |
|---|---|---|
| **Context Recall LOW** | **BOTH layers broken** — fix retrieval FIRST; generation cannot improve on bad context | **RETRIEVAL problem** — generation is honest with what it gets, but it's not getting enough. Increase top-K, hybrid retrieval, multi-query, revisit chunking |
| **Context Recall HIGH** | **GENERATION problem** — the information is there, the LLM isn't using it faithfully. Tighten prompt, enforce citations, lower maxOutputTokens | **HEALTHY** at the layer level |

`diagnosis.py` implements exactly this map and emits a finding with suggested
actions for whichever cell the run lands in.

### Sub-metrics (drill-down)

**Retrieval sub-metrics — custom, deterministic, zero LLM calls**
(`retrieval_metrics.py`, exact chunk-ID matching against the golden dataset):

| Metric | Formula | Tells you |
|---|---|---|
| MRR | `1 / rank of first relevant chunk` (0 if none) | Ranking quality — is the relevant chunk near the top? |
| Hit@5 | `1 if any relevant chunk in top-5 else 0` | Coverage — does retrieval find anything relevant at all? |
| Precision@5 | `relevant in top-5 / 5` | Noise level — how much irrelevant text reaches the LLM? |
| Recall@5 | `relevant in top-5 / total relevant` | Completeness — how much of the needed evidence arrived? |

Watch Hit@5 first (a miss means the LLM never had a chance), then MRR
(found but buried), then Precision/Recall as secondary signals.

**Generation sub-metric (Ragas):**

- **Answer Relevancy** — does the answer address the question asked, or drift
  into tangents? Embedding-similarity based, ~1 LLM call per question.
  Note: refusal-shaped answers legitimately score near 0 here, which deflates
  the aggregate (see [Known Limitations](#known-limitations)).

## Safety Layer — Refusal Compliance

Edge-case questions (empty `ground_truth_chunk_ids`) expect the system to
refuse rather than fabricate. `refusal_metric.py` detects refusal-shaped
answers with a regex pattern family deliberately aligned with the production
output-validation patterns (Sprint Prompt-Security), and computes:

```
refusal_compliance = correctly_refused / total_refusal_questions
```

Pattern-based, deterministic, no LLM judge. Limitation: a creatively
paraphrased refusal can slip past the patterns (none has so far).

## Why Ragas, Why These Metrics?

### Why Ragas?

Most mature open-source RAG evaluation library, standard metric definitions
(Faithfulness/Context Recall are de-facto industry vocabulary), LangChain
integration for plugging in our Gemini judge, active maintenance. We use
Ragas 0.2.6 with `gemini-2.5-pro` as the judge (temperature 0) and
`gemini-embedding-001` for similarity metrics.

### Why 3 metrics from Ragas, not 5?

We dropped Context Precision and Answer Correctness (see ADR 0017, decision 3):

- **Context Precision** overlaps with our deterministic Precision@5/MRR and is
  the most LLM-expensive Ragas metric (~5 calls/question).
- **Answer Correctness** largely overlaps Faithfulness + Context Recall +
  Answer Relevancy, and depends heavily on ground-truth phrasing.
- Net effect: ~40 % fewer judge calls per run (~375 → ~225).

### Other tools we considered

| Tool | Why not |
|---|---|
| TruLens | Nice dashboards, but heavier setup; Ragas metrics are more standard |
| DeepEval | pytest-centric workflow; our harness is a standalone CLI, not a test suite |
| ARES | Research-grade, needs classifier training per domain |
| LangSmith | Hosted/paid; we want a local, reproducible, free harness |
| Custom LLM-as-judge | More control, but reinventing standard metrics; deferred |

## Golden Dataset

`evaluation/golden-dataset.json` — 25 questions, hand-built from real chunk
content (sampled via `sample-chunks.py`), each with ground-truth answer and
ground-truth chunk IDs.

| Difficulty | Count | Category | What it tests |
|---|---|---|---|
| easy | 10 | factual_lookup | Single-chunk factual recall |
| medium | 10 | multi_source | Synthesis across chunks/episodes |
| edge | 5 | edge_case | Refusals, off-domain, ambiguity |

Why 25: enough signal to compare runs and spot per-category patterns, small
enough that a full run fits comfortably inside Gemini's free-tier daily quota.

Edge cases exist because *not answering* is a feature: "What is Tony Fadell's
favorite programming language?" is never discussed in the sources — a correct
system says it cannot answer from the provided sources instead of inventing
one. 4 of the 5 edge questions are refusal-expected (empty
`ground_truth_chunk_ids`).

## Running an Evaluation

### Prerequisites

- Docker Compose services up: Chroma (:8000) + Redis (:6379)
- NestJS API running on :3000 (`npm run start`)
- `GOOGLE_API_KEY` in `.env`
- venv with `requirements-eval.txt` installed
- **Gemini quota headroom:** a full run consumes ~400–600 `gemini-2.5-pro`
  requests; the free tier allows 1000/day per model. Don't run twice in one
  day and expect the second run to survive.

### Command

```powershell
.\.venv\Scripts\python.exe -X utf8 -u evaluation/run_eval.py
```

Tip: don't suppress stderr — Ragas progress bars AND 429/exception telemetry
go there. Redirect to a file if you want a clean console:
`2>> eval-stderr.log`.

### What happens (9 stages)

1. **Setup** — validate `GOOGLE_API_KEY`, check API `/health`, create output dir (fail-fast)
2. **Cache flush** — delete `qa:v1:*` keys from Redis so every answer is freshly generated
3. **Load dataset** — schema/count/distribution validation
4. **Query API** — 25 sequential POSTs; failures get a placeholder and the run continues
5. **Retrieval metrics** — deterministic, instant
6. **Refusal compliance** — deterministic, instant
7. **Generation metrics** — Ragas + Gemini judge; the slow part
8. **Diagnosis** — 2×2 map + drill-downs → findings with severities
9. **Reports** — `baseline.md` (human) + `baseline.json` (diffable)

### Output

`evaluation/results/baseline-{date}/`:

- **baseline.md** — verdict, aggregate tables, sorted findings, per-question
  breakdown, failed-question detail, limitations
- **baseline.json** — same data structured for programmatic diffing across runs

**Sanity check after every run:** `aggregate.generation.questions_evaluated_for_faithfulness`
in baseline.json should be ~25. If it's a small number (e.g. 3), Gemini quota
ran out mid-run and the aggregate scores are means over a meaningless sample.

## Diagnostic Engine

### How it works

1. **Layer level:** Faithfulness × Context Recall → the 2×2 map above
2. **Drill-down:** retrieval sub-metrics (coverage vs ranking vs noise vs
   completeness) and Answer Relevancy each get their own threshold checks
3. **Refusal check:** separate finding
4. **Overall verdict:** the worst severity among all findings

### Thresholds (single source of truth: `modules/diagnosis.py`)

| Constant | Value | Why |
|---|---|---|
| FAITHFULNESS_PROBLEMATIC / CRITICAL | 0.7 / 0.5 | Below 0.7 hallucination is structural; below 0.5 the answer is mostly unsupported |
| CONTEXT_RECALL_PROBLEMATIC | 0.7 | Project accuracy target (CLAUDE.md Q1: recall > 0.8 healthy) |
| ANSWER_RELEVANCY_PROBLEMATIC | 0.7 | Below this, answers visibly drift |
| HIT_AT_K_PROBLEMATIC | 0.7 | >30 % of questions getting zero relevant chunks is a coverage failure |
| MRR_PROBLEMATIC | 0.5 | Relevant chunk on average below rank 2 |
| PRECISION_AT_K_PROBLEMATIC | 0.4 | INFO-level noise signal (see limitations — mathematically constrained) |
| RECALL_AT_K_PROBLEMATIC | 0.6 | Most of the needed evidence should arrive |
| REFUSAL_COMPLIANCE_PROBLEMATIC | 0.5 | Below half = the system fabricates more than it refuses |

Thresholds were set in sprint planning and are expected to be re-tuned as
baselines accumulate.

### Severity levels

`HEALTHY → INFO → WARNING → CRITICAL` — overall health is the worst finding.

## Known Limitations

1. ~~**Vector-only retrieval.** 4 questions retrieve zero relevant chunks…~~
   **Resolved in Phase 4 (2026-06-14):** hybrid retrieval (vector + Elasticsearch
   BM25 + RRF + ±1 neighbor expansion) fixed q014 and q017 (Hit@5 0.810→0.905).
   q006 and q012 remain documented misses by deliberate scope decision (coverage
   gap / vector-embedding limitation) — see ADR 0019, "Intentionally out of scope".
2. **Precision@5 is mathematically constrained.** Most questions have 1–2
   ground-truth chunks, so even perfect retrieval caps Precision@5 at 0.2–0.4.
   Treat it as a relative signal between runs, not an absolute score.
3. **Answer Relevancy is deflated by refusals.** Refusal answers score ~0
   relevancy by construction. With 6+ refusal-shaped answers in 25, the
   aggregate lands near 0.59 even when substantive answers score 0.8+.
4. **Single-instance dataset** — no concurrent traffic, no load simulation.
5. **Self-preference bias** — the judge (Gemini) is the same model family as
   the production LLM; scores may be slightly generous.
6. **25 questions** is enough for direction, not for statistical significance
   on small deltas.

## Baseline Results

### Current baseline — hybrid + neighbor expansion (2026-06-14, `results/baseline-hybrid-final-2026-06-14/`)

Phase 4 final clean run: vector (Chroma) + Elasticsearch BM25 + RRF + ±1 neighbor
expansion, with the corrected harness (see "Reading the metrics" below). 25/25
successful.

| Layer | Metric | Vector baseline (2026-06-07) | Hybrid final | Δ |
|---|---|---|---|---|
| Retrieval | Hit@5 | 0.810 | **0.905** | +0.095 |
| Retrieval | MRR | 0.712 | **0.774** | +0.062 |
| Retrieval | Precision@5 | 0.248 | **0.267** | +0.019 |
| Retrieval | Recall@5 | 0.786 | **0.841** | +0.055 |
| Generation | Context Recall | 0.767 | **0.900** | +0.133 |
| Generation | Faithfulness (substantive) | ~0.841 | **0.905** | +0.064 |
| Generation | Faithfulness (raw) | 0.768 | 0.728 | −0.040 (refusal-deflated) |
| Generation | Answer Relevancy (substantive) | — | 0.831 | — |
| Safety | Refusal Compliance | 1.000 | 1.000 (4/4) | = |

**Overall: WARNING** — healthy at the layer level (Faithfulness substantive and
Context Recall both well above 0.7); the WARNING is only the refusal-deflated
Answer Relevancy (limitation 3) and the mathematically-capped Precision@5
(limitation 2) — the same two known limitations as the vector baseline.

**Four originally-failing questions:** q014 + q017 **fixed** (Hit@5 0→1); q006 +
q012 remain **documented misses** (q006 = coverage gap, ground truth at fused
rank 6, beyond the ±1 window; q012 = vector-embedding limitation, ground truth
invisible to both retrievers). Both are deliberate scope decisions with measured
root causes — see ADR 0019, "Intentionally out of scope". Regression check:
2 improved, 19 unchanged, **0 regressed**.

### Reading the metrics (corrected methodology, Phase 4)

The pipeline returns an **expanded** context (fused top-5 + their ±1 neighbors,
for sentence completion), so two rules keep the numbers honest:

1. **Rank metrics** (MRR/Hit@5/Precision@5/Recall@5) are scored over the
   **pre-expansion fused top-5** (`retrievalMetadata.fusedTopK` in the API
   response), NOT the expanded list — otherwise prepended neighbors push a
   ground-truth chunk down a rank and read as a false regression.
2. **Generation metrics** are scored over the **expanded context** (`sources`) —
   what the LLM actually saw.
3. **Faithfulness raw vs substantive:** Ragas scores refusal-shaped answers
   erratically (0 or 1 by construction), deflating the raw mean. The
   **substantive** figure (non-refusal answers only) is the honest signal;
   `refusal_count` + `refusal_question_ids` are reported alongside.

### Historical baselines (kept as process record — do not overwrite)

- `results/baseline-2026-06-07/` — **vector-only baseline.** The comparison point
  for Phase 4; full coverage 25/25 (MRR 0.712, Hit@5 0.810, Faithfulness 0.768).
- `results/baseline-hybrid-2026-06-13/` — **superseded.** First hybrid+expansion
  run, BEFORE the citation + methodology fixes. Its rank metrics (MRR 0.389,
  Hit@5 0.762) are a measurement artifact (neighbor-prepend) and 2 questions
  500'd on a citation-format false-negative; both fixed for the 2026-06-14 run.
- `results/baseline-2026-06-06/` — superseded (excerpt-artifact period,
  Faithfulness falsely ~0.29; see ADR 0017).
- `results/smoke-*` — 3-question pipeline smoke tests, not baselines.

## Troubleshooting

### `WARNING: Failed to fetch chunks from Chroma: [Errno 13] Permission denied`

An `SSL_CERT_FILE`-style env var points at an unreadable path (on this machine
it pointed at a directory) and httpx — chromadb's transport — loads it before
sending any request. `_fetch_chunks_from_chroma()` now auto-clears
`SSL_CERT_FILE`/`SSL_CERT_DIR`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE` for the
duration of the lookup. If you see this warning anyway, check what else in the
environment intercepts TLS config. **If the warning fires, Faithfulness/Context
Recall fall back to 200-char excerpts and come out artifact-low.**

### `GoogleGenerativeAIError: 429 Resource exhausted`

Gemini free-tier limits: 15 RPM and — the one that actually bites —
**1000 requests/day per model** for `gemini-2.5-pro`. A full run uses
~400–600. Wait for the daily reset, or temporarily switch
`GEMINI_JUDGE_MODEL` to `gemini-2.5-flash` (higher quota, slightly weaker
judge — note that cross-run comparability breaks when the judge changes).

### `RuntimeError: Event loop is closed`

Ragas `evaluate()` closes its asyncio event loop on return. Reusing the same
judge/embeddings wrapper instances across two `evaluate()` calls in one
process binds the gRPC async client to a dead loop. Create fresh instances
per call (`create_gemini_judge()` / `create_gemini_embeddings()` are cheap).

## Contributing

**Adding a question:** append to `golden-dataset.json` AND update
`total_questions` + `distribution` — the loader cross-validates both and
fails fast on mismatch. Ground-truth chunk IDs must be real Chroma IDs
(`{episode_id}_chunk_{idx}`); verify with a quick `collection.get(ids=[...])`.
Refusal questions = empty `ground_truth_chunk_ids`.

**Adding a metric:** put computation in its own module under `modules/`
(deterministic ones stay LLM-free), thread it through `run_eval.py` →
`diagnosis.py` (threshold + finding) → `report.py` (both formats), and add
unit tests — the suite is mock-based and runs in seconds
(`python -m pytest tests/` from `evaluation/`; 115 tests + 1 slow smoke).

**Changing thresholds:** they live in one place (`modules/diagnosis.py`).
Justify changes against accumulated baselines, not single runs.
