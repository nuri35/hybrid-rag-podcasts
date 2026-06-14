# RAG Evaluation Report — 2026-06-14

**Dataset version:** 1.0
**Total questions:** 25
**Generated:** 2026-06-14T13:32:08

## Overall Verdict

⚠️ **Issues detected — review diagnostic findings.**

## Aggregate Scores

### Retrieval Metrics (Custom)

| Metric | Value | k |
|---|---|---|
| MRR | 0.774 | — |
| Hit@K | 0.905 | 5 |
| Precision@K | 0.267 | 5 |
| Recall@K | 0.841 | 5 |

*Evaluated on 21 questions (4 refusal questions skipped)*

### Generation Metrics (Ragas)

Substantive = non-refusal answers only (Phase 4); refusals are scored erratically by Ragas and reported separately under Refusal Compliance.

| Metric | Raw (all) | Substantive (non-refusal) |
|---|---|---|
| Faithfulness | 0.728 | 0.905 |
| Answer Relevancy | 0.631 | 0.831 |
| Context Recall | 0.900 | — |

*Excluded 6 refusal answer(s) from the substantive aggregate: q005, q010, q011, q012, q020, q025.*

### Refusal Compliance

- **Refusal compliance:** 1.000
- **Correctly refused:** 4 / 4

## Diagnostic Findings

### ⚠️ Answer Relevancy is low — answers are off-topic or unfocused

**Severity:** WARNING  
**Layer:** GENERATION

Answer Relevancy = 0.631. The LLM is producing answers that drift from the question or include tangential content.

**Suggested actions:**

- Add explicit prompt instruction: 'Answer ONLY the question asked, no tangents'
- Lower maxOutputTokens to constrain answer length
- Add few-shot examples of focused answers

### ℹ️ Precision@5 is low — noise problem

**Severity:** INFO  
**Layer:** RETRIEVAL

Precision@5 = 0.267. Too many irrelevant chunks are in top-5, which can confuse the LLM.

**Suggested actions:**

- Add a re-ranker to push noise down
- Raise similarity threshold (filter out low-score chunks)
- Reduce top-K to 3

### ✅ System is healthy at the layer level

**Severity:** HEALTHY  
**Layer:** SYSTEM

Faithfulness (0.728) and Context Recall (0.900) are both above thresholds. Both retrieval and generation layers are functioning well.

### ✅ Refusal compliance is healthy

**Severity:** HEALTHY  
**Layer:** REFUSAL

Refusal compliance = 1.000 (4/4 correctly refused).

## Per-Question Breakdown

| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |
|---|---|---|---|---|---|---|
| q001 | easy | 0.25 | 1 | 1.00 | 0.89 | — |
| q002 | easy | 1.00 | 1 | 1.00 | 0.78 | — |
| q003 | medium | 1.00 | 1 | 1.00 | 0.84 | — |
| q004 | medium | 1.00 | 1 | 0.73 | 0.86 | — |
| q005 | edge | — | — | 1.00 | 0.00 | ✓ |
| q006 | easy | 0.00 | 0 | 0.91 | 0.78 | — |
| q007 | medium | 1.00 | 1 | 1.00 | 0.85 | — |
| q008 | easy | 1.00 | 1 | 1.00 | 0.77 | — |
| q009 | medium | 0.50 | 1 | 1.00 | 0.82 | — |
| q010 | edge | — | — | 0.00 | 0.00 | ✓ |
| q011 | easy | 1.00 | 1 | 1.00 | 0.00 | — |
| q012 | medium | 0.00 | 0 | 0.00 | 0.00 | — |
| q013 | easy | 0.50 | 1 | 0.00 | 0.87 | — |
| q014 | medium | 0.50 | 1 | 1.00 | 0.89 | — |
| q015 | edge | 1.00 | 1 | 1.00 | 0.84 | — |
| q016 | easy | 1.00 | 1 | 1.00 | 0.75 | — |
| q017 | medium | 1.00 | 1 | 1.00 | 0.93 | — |
| q018 | easy | 0.50 | 1 | 0.33 | 0.87 | — |
| q019 | medium | 1.00 | 1 | 0.75 | 0.84 | — |
| q020 | edge | — | — | 1.00 | 0.00 | ✓ |
| q021 | easy | 1.00 | 1 | 1.00 | 0.74 | — |
| q022 | medium | 1.00 | 1 | 1.00 | 0.81 | — |
| q023 | easy | 1.00 | 1 | 0.71 | 0.87 | — |
| q024 | medium | 1.00 | 1 | 1.00 | 0.84 | — |
| q025 | edge | — | — | 1.00 | 0.00 | ✓ |

## Failed Questions (Detail)

_Questions where one or more metrics fell below thresholds._

### q001 (easy)

**Question:** What was the nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11?

**Answer:** The nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11 was "Tally Ho" [Source 9, Source 10].

**Issues:** low MRR (0.25)

### q005 (edge)

**Question:** What is Tony Fadell's favorite programming language?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low relevancy (0.00)

### q006 (easy)

**Question:** Why does Lee Cronin say biology is not a Turing machine?

**Answer:** Lee Cronin suggests that the universe might not be a computer and that there are constructors that build computers, implying a distinction between the fundamental nature of the universe and computatio...

**Issues:** low MRR (0.00), missed hit@5

### q010 (edge)

**Question:** What is the capital of France?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

### q011 (easy)

**Question:** Which physicist does Richard Dawkins agree with about there being a genuine mystery to consciousness?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low relevancy (0.00)

### q012 (medium)

**Question:** How does Sebastian Thrun use the example of human walking to explain why machine learning matters?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.00), low relevancy (0.00)

### q013 (easy)

**Question:** By what deadline does Tim Urban's bet require a human to have touched Mars?

**Answer:** Tim Urban's bet requires a human to have touched Mars by the end of 2030, or by January 1st, 2031 [Source 2, Source 3].

**Issues:** low faithfulness (0.00)

### q018 (easy)

**Question:** According to Tony Fadell, how did Steve Jobs deliver criticism?

**Answer:** According to Tony Fadell, Steve Jobs would critique the work, not judge the person, and this was not done in a demeaning or bullying way, at least not in front of others [Source 5]. He was relentless ...

**Issues:** low faithfulness (0.33)

### q020 (edge)

**Question:** Which university is Richard Dawkins affiliated with?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low relevancy (0.00)

### q025 (edge)

**Question:** How do I bake chocolate chip cookies?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low relevancy (0.00)

## Limitations

- Single-instance dataset; no concurrent traffic simulation
- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production
  inference, so self-preference bias is possible
- Context excerpts are 200-char snippets, not full chunks — may affect
  faithfulness scoring nuance
- Refusal compliance uses pattern matching, not LLM judgment — may miss
  paraphrased refusals
