# RAG Evaluation Report — 2026-06-05

**Dataset version:** 1.0
**Total questions:** 3
**Generated:** 2026-06-05T15:54:28

## Overall Verdict

⚠️ **Issues detected — review diagnostic findings.**

## Aggregate Scores

### Retrieval Metrics (Custom)

| Metric | Value | k |
|---|---|---|
| MRR | 0.667 | — |
| Hit@K | 0.667 | 5 |
| Precision@K | 0.200 | 5 |
| Recall@K | 0.667 | 5 |

*Evaluated on 3 questions (0 refusal questions skipped)*

### Generation Metrics (Ragas)

| Metric | Value |
|---|---|
| Faithfulness | N/A |
| Answer Relevancy | N/A |
| Context Precision | 0.000 |
| Context Recall | N/A |
| Answer Correctness | N/A |

## Diagnostic Findings

### ⚠️ Layer-level diagnosis incomplete

**Severity:** WARNING  
**Layer:** SYSTEM

Cannot perform full layer diagnosis — faithfulness=N/A, context_recall=N/A. This usually means most questions are refusal-type or Ragas returned NaN.

**Suggested actions:**

- Ensure dataset has enough non-refusal questions for context metrics
- Investigate Ragas output for NaN patterns

### ⚠️ Hit@5 is low — coverage problem

**Severity:** WARNING  
**Layer:** RETRIEVAL

Hit@5 = 0.667. The retrieval often fails to return any relevant chunk in top-5.

**Suggested actions:**

- Increase top-K (try 10)
- Switch to a stronger embedding model
- Add hybrid retrieval (BM25 alongside vector)
- Review chunking strategy

### ℹ️ Precision@5 is low — noise problem

**Severity:** INFO  
**Layer:** RETRIEVAL

Precision@5 = 0.200. Too many irrelevant chunks are in top-5, which can confuse the LLM.

**Suggested actions:**

- Add a re-ranker to push noise down
- Raise similarity threshold (filter out low-score chunks)
- Reduce top-K to 3

### ℹ️ Context Precision is low — LLM is processing too much noise

**Severity:** INFO  
**Layer:** GENERATION

Context Precision = 0.000. The retrieved chunks include many that aren't needed to answer the question. This can degrade generation quality even when the right information IS present.

**Suggested actions:**

- Add a re-ranker to filter chunks before sending to the LLM
- Raise similarity threshold
- Reduce top-K

## Per-Question Breakdown

| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |
|---|---|---|---|---|---|---|
| q001 | easy | 0.00 | 0 | — | — | — |
| q002 | easy | 1.00 | 1 | — | — | — |
| q003 | medium | 1.00 | 1 | — | — | — |

## Failed Questions (Detail)

_Questions where one or more metrics fell below thresholds._

### q001 (easy)

**Question:** What was the nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11?

**Answer:** [QUERY FAILED]

**Issues:** low MRR (0.00), missed hit@5

## Limitations

- Single-instance dataset; no concurrent traffic simulation
- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production
  inference, so self-preference bias is possible
- Context excerpts are 200-char snippets, not full chunks — may affect
  faithfulness scoring nuance
- Refusal compliance uses pattern matching, not LLM judgment — may miss
  paraphrased refusals
