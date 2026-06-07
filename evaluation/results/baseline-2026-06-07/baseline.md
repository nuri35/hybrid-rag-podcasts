# RAG Evaluation Report — 2026-06-07

**Dataset version:** 1.0
**Total questions:** 25
**Generated:** 2026-06-07T14:06:22

## Overall Verdict

⚠️ **Issues detected — review diagnostic findings.**

## Aggregate Scores

### Retrieval Metrics (Custom)

| Metric | Value | k |
|---|---|---|
| MRR | 0.712 | — |
| Hit@K | 0.810 | 5 |
| Precision@K | 0.248 | 5 |
| Recall@K | 0.786 | 5 |

*Evaluated on 21 questions (4 refusal questions skipped)*

### Generation Metrics (Ragas)

| Metric | Value |
|---|---|
| Faithfulness | 0.768 |
| Answer Relevancy | 0.589 |
| Context Recall | 0.767 |

### Refusal Compliance

- **Refusal compliance:** 1.000
- **Correctly refused:** 4 / 4

## Diagnostic Findings

### ⚠️ Answer Relevancy is low — answers are off-topic or unfocused

**Severity:** WARNING  
**Layer:** GENERATION

Answer Relevancy = 0.589. The LLM is producing answers that drift from the question or include tangential content.

**Suggested actions:**

- Add explicit prompt instruction: 'Answer ONLY the question asked, no tangents'
- Lower maxOutputTokens to constrain answer length
- Add few-shot examples of focused answers

### ℹ️ Precision@5 is low — noise problem

**Severity:** INFO  
**Layer:** RETRIEVAL

Precision@5 = 0.248. Too many irrelevant chunks are in top-5, which can confuse the LLM.

**Suggested actions:**

- Add a re-ranker to push noise down
- Raise similarity threshold (filter out low-score chunks)
- Reduce top-K to 3

### ✅ System is healthy at the layer level

**Severity:** HEALTHY  
**Layer:** SYSTEM

Faithfulness (0.768) and Context Recall (0.767) are both above thresholds. Both retrieval and generation layers are functioning well.

### ✅ Refusal compliance is healthy

**Severity:** HEALTHY  
**Layer:** REFUSAL

Refusal compliance = 1.000 (4/4 correctly refused).

## Per-Question Breakdown

| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |
|---|---|---|---|---|---|---|
| q001 | easy | 0.25 | 1 | 1.00 | 0.89 | — |
| q002 | easy | 1.00 | 1 | 1.00 | 0.86 | — |
| q003 | medium | 1.00 | 1 | 1.00 | 0.83 | — |
| q004 | medium | 1.00 | 1 | 0.92 | 0.86 | — |
| q005 | edge | — | — | 0.00 | 0.00 | ✓ |
| q006 | easy | 0.00 | 0 | 0.00 | 0.00 | — |
| q007 | medium | 1.00 | 1 | 0.95 | 0.88 | — |
| q008 | easy | 1.00 | 1 | 0.83 | 0.79 | — |
| q009 | medium | 1.00 | 1 | 0.83 | 0.77 | — |
| q010 | edge | — | — | 1.00 | 0.00 | ✓ |
| q011 | easy | 1.00 | 1 | 0.00 | 0.78 | — |
| q012 | medium | 0.00 | 0 | 1.00 | 0.00 | — |
| q013 | easy | 1.00 | 1 | 0.50 | 0.86 | — |
| q014 | medium | 0.00 | 0 | 0.82 | 0.89 | — |
| q015 | edge | 1.00 | 1 | 1.00 | 0.88 | — |
| q016 | easy | 1.00 | 1 | 0.80 | 0.74 | — |
| q017 | medium | 0.00 | 0 | 0.00 | 0.00 | — |
| q018 | easy | 1.00 | 1 | 0.90 | 0.76 | — |
| q019 | medium | 1.00 | 1 | 1.00 | 0.75 | — |
| q020 | edge | — | — | 0.00 | 0.00 | ✓ |
| q021 | easy | 1.00 | 1 | 1.00 | 0.74 | — |
| q022 | medium | 1.00 | 1 | 0.83 | 0.76 | — |
| q023 | easy | 0.20 | 1 | 0.58 | 0.87 | — |
| q024 | medium | 0.50 | 1 | 1.00 | 0.84 | — |
| q025 | edge | — | — | 0.00 | 0.00 | ✓ |

## Failed Questions (Detail)

_Questions where one or more metrics fell below thresholds._

### q001 (easy)

**Question:** What was the nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11?

**Answer:** The nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11 was "Tally Ho" [Source 4, Source 5].

**Issues:** low MRR (0.25)

### q005 (edge)

**Question:** What is Tony Fadell's favorite programming language?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

### q006 (easy)

**Question:** Why does Lee Cronin say biology is not a Turing machine?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.00), low relevancy (0.00)

### q010 (edge)

**Question:** What is the capital of France?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low relevancy (0.00)

### q011 (easy)

**Question:** Which physicist does Richard Dawkins agree with about there being a genuine mystery to consciousness?

**Answer:** Richard Dawkins agrees with Roger Penrose that there is a mystery to consciousness [Source 1]. He states, "I agree with Roger Penrose that there is a mystery there" [Source 1].

**Issues:** low faithfulness (0.00)

### q012 (medium)

**Question:** How does Sebastian Thrun use the example of human walking to explain why machine learning matters?

**Answer:** The provided sources do not contain information on how Sebastian Thrun uses the example of human walking to explain why machine learning matters.

**Issues:** low MRR (0.00), missed hit@5, low relevancy (0.00)

### q013 (easy)

**Question:** By what deadline does Tim Urban's bet require a human to have touched Mars?

**Answer:** Tim Urban's bet requires a human to have touched Mars by January 1st, 2031 [Source 1]. The bet was made that the Neil Armstrong of Mars will set foot by the end of 2030 [Source 2].

**Issues:** low faithfulness (0.50)

### q014 (medium)

**Question:** Why does Jo Boaler advocate a multidimensional approach to teaching math?

**Answer:** Jo Boaler advocates for a multidimensional approach to teaching math because it fosters more connections between different pathways in the brain, leading to a "great connected brain" [Source 1]. This ...

**Issues:** low MRR (0.00), missed hit@5

### q017 (medium)

**Question:** What does Lee Cronin mean when he distinguishes constructors from abstractors?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.00), low relevancy (0.00)

### q020 (edge)

**Question:** Which university is Richard Dawkins affiliated with?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

### q023 (easy)

**Question:** What does Lee Cronin speculate dark energy might actually be?

**Answer:** Lee Cronin speculates that dark energy could be a new energy field that pervades the universe, similar to electromagnetism but very different [Source 1, Source 2]. This type of energy could potentiall...

**Issues:** low MRR (0.20), low faithfulness (0.58)

### q025 (edge)

**Question:** How do I bake chocolate chip cookies?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

## Limitations

- Single-instance dataset; no concurrent traffic simulation
- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production
  inference, so self-preference bias is possible
- Context excerpts are 200-char snippets, not full chunks — may affect
  faithfulness scoring nuance
- Refusal compliance uses pattern matching, not LLM judgment — may miss
  paraphrased refusals
