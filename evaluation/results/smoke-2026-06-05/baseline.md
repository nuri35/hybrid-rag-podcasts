# RAG Evaluation Report — 2026-06-05

**Dataset version:** 1.0
**Total questions:** 3
**Generated:** 2026-06-05T16:20:22

## Overall Verdict

🔴 **Critical issues — action required before deployment.**

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
| Faithfulness | 0.143 |
| Answer Relevancy | 0.566 |
| Context Precision | 0.333 |
| Context Recall | 0.167 |
| Answer Correctness | 0.616 |

## Diagnostic Findings

### 🔴 Both retrieval and generation are underperforming

**Severity:** CRITICAL  
**Layer:** BOTH

Faithfulness (0.143) and Context Recall (0.167) are both below 0.7. This indicates retrieval is missing key information AND generation is hallucinating with what it has.

**Suggested actions:**

- Focus on retrieval FIRST — generation cannot improve until context is correct
- Increase top-K or add hybrid retrieval (BM25 + vector)
- Re-evaluate after retrieval fix, then revisit generation

### ⚠️ Hit@5 is low — coverage problem

**Severity:** WARNING  
**Layer:** RETRIEVAL

Hit@5 = 0.667. The retrieval often fails to return any relevant chunk in top-5.

**Suggested actions:**

- Increase top-K (try 10)
- Switch to a stronger embedding model
- Add hybrid retrieval (BM25 alongside vector)
- Review chunking strategy

### ⚠️ Answer Relevancy is low — answers are off-topic or unfocused

**Severity:** WARNING  
**Layer:** GENERATION

Answer Relevancy = 0.566. The LLM is producing answers that drift from the question or include tangential content.

**Suggested actions:**

- Add explicit prompt instruction: 'Answer ONLY the question asked, no tangents'
- Lower maxOutputTokens to constrain answer length
- Add few-shot examples of focused answers

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

Context Precision = 0.333. The retrieved chunks include many that aren't needed to answer the question. This can degrade generation quality even when the right information IS present.

**Suggested actions:**

- Add a re-ranker to filter chunks before sending to the LLM
- Raise similarity threshold
- Reduce top-K

## Per-Question Breakdown

| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |
|---|---|---|---|---|---|---|
| q001 | easy | 0.00 | 0 | — | 0.00 | — |
| q002 | easy | 1.00 | 1 | 0.00 | 0.87 | — |
| q003 | medium | 1.00 | 1 | 0.29 | 0.83 | — |

## Failed Questions (Detail)

_Questions where one or more metrics fell below thresholds._

### q001 (easy)

**Question:** What was the nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11?

**Answer:** [QUERY FAILED]

**Issues:** low MRR (0.00), missed hit@5, low relevancy (0.00)

### q002 (easy)

**Question:** What bug caused Stanley, the Stanford autonomous car, to fail every 30 miles during DARPA Grand Challenge development?

**Answer:** Stanley, the car that eventually won the DARPA Grand Challenge, would commit suicide every 30 miles due to a bug where the sinking of two computer clocks occasionally caused a clock to go backwards. T...

**Issues:** low faithfulness (0.00)

### q003 (medium)

**Question:** How does Richard Dawkins distinguish between the two modes of meme transmission, and what does he compare each one to?

**Answer:** Richard Dawkins distinguishes between two modes of meme transmission. One mode is longitudinal, from grandparent to parent to child, which he compares to conventional genetic transmission [Source 2]. ...

**Issues:** low faithfulness (0.29)

## Limitations

- Single-instance dataset; no concurrent traffic simulation
- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production
  inference, so self-preference bias is possible
- Context excerpts are 200-char snippets, not full chunks — may affect
  faithfulness scoring nuance
- Refusal compliance uses pattern matching, not LLM judgment — may miss
  paraphrased refusals
