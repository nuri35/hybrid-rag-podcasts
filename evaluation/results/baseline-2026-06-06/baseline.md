# RAG Evaluation Report — 2026-06-06

**Dataset version:** 1.0
**Total questions:** 25
**Generated:** 2026-06-06T17:28:52

## Overall Verdict

🔴 **Critical issues — action required before deployment.**

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
| Faithfulness | 0.292 |
| Answer Relevancy | 0.585 |
| Context Recall | 0.407 |

### Refusal Compliance

- **Refusal compliance:** 1.000
- **Correctly refused:** 4 / 4

## Diagnostic Findings

### 🔴 Both retrieval and generation are underperforming

**Severity:** CRITICAL  
**Layer:** BOTH

Faithfulness (0.292) and Context Recall (0.407) are both below 0.7. This indicates retrieval is missing key information AND generation is hallucinating with what it has.

**Suggested actions:**

- Focus on retrieval FIRST — generation cannot improve until context is correct
- Increase top-K or add hybrid retrieval (BM25 + vector)
- Re-evaluate after retrieval fix, then revisit generation

### ⚠️ Answer Relevancy is low — answers are off-topic or unfocused

**Severity:** WARNING  
**Layer:** GENERATION

Answer Relevancy = 0.585. The LLM is producing answers that drift from the question or include tangential content.

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

### ✅ Refusal compliance is healthy

**Severity:** HEALTHY  
**Layer:** REFUSAL

Refusal compliance = 1.000 (4/4 correctly refused).

## Per-Question Breakdown

| ID | Difficulty | MRR | Hit@K | Faithfulness | Relevancy | Refusal |
|---|---|---|---|---|---|---|
| q001 | easy | 0.25 | 1 | 1.00 | 0.89 | — |
| q002 | easy | 1.00 | 1 | 0.00 | 0.87 | — |
| q003 | medium | 1.00 | 1 | 0.43 | 0.83 | — |
| q004 | medium | 1.00 | 1 | 0.50 | 0.86 | — |
| q005 | edge | — | — | 0.00 | 0.00 | ✓ |
| q006 | easy | 0.00 | 0 | 0.00 | 0.00 | — |
| q007 | medium | 1.00 | 1 | 0.20 | 0.88 | — |
| q008 | easy | 1.00 | 1 | 0.00 | 0.80 | — |
| q009 | medium | 1.00 | 1 | 0.08 | 0.77 | — |
| q010 | edge | — | — | 0.00 | 0.00 | ✓ |
| q011 | easy | 1.00 | 1 | 0.00 | 0.78 | — |
| q012 | medium | 0.00 | 0 | 1.00 | 0.00 | — |
| q013 | easy | 1.00 | 1 | 0.50 | — | — |
| q014 | medium | 0.00 | 0 | 0.45 | 0.89 | — |
| q015 | edge | 1.00 | 1 | 0.17 | — | — |
| q016 | easy | 1.00 | 1 | 0.20 | 0.74 | — |
| q017 | medium | 0.00 | 0 | 0.00 | 0.00 | — |
| q018 | easy | 1.00 | 1 | 0.40 | 0.75 | — |
| q019 | medium | 1.00 | 1 | 0.17 | 0.75 | — |
| q020 | edge | — | — | 0.00 | 0.00 | ✓ |
| q021 | easy | 1.00 | 1 | 0.00 | 0.74 | — |
| q022 | medium | 1.00 | 1 | 0.00 | 0.76 | — |
| q023 | easy | 0.20 | 1 | 0.08 | 0.88 | — |
| q024 | medium | 0.50 | 1 | 0.75 | 0.84 | — |
| q025 | edge | — | — | 0.00 | — | ✓ |

## Failed Questions (Detail)

_Questions where one or more metrics fell below thresholds._

### q001 (easy)

**Question:** What was the nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11?

**Answer:** The nickname of Niels Jorgensen's fire company that he heard over the radio on 9/11 was "Tally Ho" [Source 4, Source 5].

**Issues:** low MRR (0.25)

### q002 (easy)

**Question:** What bug caused Stanley, the Stanford autonomous car, to fail every 30 miles during DARPA Grand Challenge development?

**Answer:** Stanley, the car that eventually won the DARPA Grand Challenge, would commit suicide every 30 miles due to a bug where the sinking of two computer clocks occasionally caused a clock to go backwards. T...

**Issues:** low faithfulness (0.00)

### q003 (medium)

**Question:** How does Richard Dawkins distinguish between the two modes of meme transmission, and what does he compare each one to?

**Answer:** Richard Dawkins distinguishes between two modes of meme transmission. One mode is longitudinal, from grandparent to parent to child, which he compares to conventional genetic transmission [Source 2]. ...

**Issues:** low faithfulness (0.43)

### q004 (medium)

**Question:** What parallel does Erik Brynjolfsson draw between free trade and technology when it comes to winners and losers?

**Answer:** Erik Brynjolfsson draws a parallel between free trade and technology in that both can make the overall pie bigger, creating wealth, but they can also be uneven in their benefits. Not everyone automati...

**Issues:** low faithfulness (0.50)

### q005 (edge)

**Question:** What is Tony Fadell's favorite programming language?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

### q006 (easy)

**Question:** Why does Lee Cronin say biology is not a Turing machine?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.00), low relevancy (0.00)

### q007 (medium)

**Question:** What distinction does Tony Fadell draw between data-driven and opinion-based decisions when building the first version of a product?

**Answer:** Tony Fadell distinguishes between data-driven and opinion-based decisions by explaining that for a V1 product, especially a consumer product, there is often a lack of data [Source 1]. In such cases, o...

**Issues:** low faithfulness (0.20)

### q008 (easy)

**Question:** Around what grade does Jo Boaler say many kids start to give up on math?

**Answer:** Many kids start to give up on themselves and math around fifth grade [Source 2]. Jo Boaler states that fifth grade can be pivotal because teachers often shift to preparing students for middle school w...

**Issues:** low faithfulness (0.00)

### q009 (medium)

**Question:** What happened to Dennis Oberg's crew when the tower began to collapse on 9/11?

**Answer:** Dennis Oberg, identified as 114's lieutenant, heard a transmission on the radio saying, "Tally Ho, respond to the Vessian West to the command post and receive your orders." [Source 1] He and his crew ...

**Issues:** low faithfulness (0.08)

### q010 (edge)

**Question:** What is the capital of France?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

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

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.45)

### q015 (edge)

**Question:** What did they say about the problem with bringing in experts?

**Answer:** The problem with bringing in experts is that they are often too good at doing "the what" but not "the why" [Source 1]. Experts may provide post hoc explanations for how and why they do things, but the...

**Issues:** low faithfulness (0.17)

### q016 (easy)

**Question:** How did the share of Americans working remotely change when the pandemic hit, according to the study Erik Brynjolfsson worked on?

**Answer:** Before the pandemic, about 15% of Americans were working remotely. When the pandemic hit, this number grew to roughly 50% [Source 1]. This shift was part of a larger transformation in work, with infor...

**Issues:** low faithfulness (0.20)

### q017 (medium)

**Question:** What does Lee Cronin mean when he distinguishes constructors from abstractors?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low MRR (0.00), missed hit@5, low faithfulness (0.00), low relevancy (0.00)

### q018 (easy)

**Question:** According to Tony Fadell, how did Steve Jobs deliver criticism?

**Answer:** Steve Jobs would critique the work, not judge the person, and it wasn't bullying or demeaning [Source 1]. He would push people, relentlessly on details and challenge them for the right reasons [Source...

**Issues:** low faithfulness (0.40)

### q019 (medium)

**Question:** What are the two reasons Tim Urban gives for why SpaceX exists?

**Answer:** SpaceX exists for two reasons: first, as life insurance for the species, ensuring humanity has a backup plan by establishing multiple self-sustaining civilizations [Source 1, Source 2]. Second, it is ...

**Issues:** low faithfulness (0.17)

### q020 (edge)

**Question:** Which university is Richard Dawkins affiliated with?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00), low relevancy (0.00)

### q021 (easy)

**Question:** How long were the classes at Jo Boaler's Stanford summer math camps?

**Answer:** The summer camp classrooms were three hours long [Source 1].

**Issues:** low faithfulness (0.00)

### q022 (medium)

**Question:** What prophetic warning did senior man Henry Miller give after the 1993 World Trade Center bombing?

**Answer:** After the 1993 bombing, Henry Miller told the speaker, "kid, it's a bad day. He said, they didn't do it right. They blew it up in the middle. If they did it in a corner, they would have dropped this b...

**Issues:** low faithfulness (0.00)

### q023 (easy)

**Question:** What does Lee Cronin speculate dark energy might actually be?

**Answer:** Lee Cronin speculates that dark energy could be a new energy field that pervades the universe, similar to electromagnetism but very different [Source 1, Source 2]. This type of energy could potentiall...

**Issues:** low MRR (0.20), low faithfulness (0.08)

### q025 (edge)

**Question:** How do I bake chocolate chip cookies?

**Answer:** I cannot answer this question from the provided sources.

**Issues:** low faithfulness (0.00)

## Limitations

- Single-instance dataset; no concurrent traffic simulation
- Ragas LLM-as-judge uses Gemini 2.5 Pro — same model family as production
  inference, so self-preference bias is possible
- Context excerpts are 200-char snippets, not full chunks — may affect
  faithfulness scoring nuance
- Refusal compliance uses pattern matching, not LLM judgment — may miss
  paraphrased refusals
