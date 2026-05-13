# Golden Questions — Evaluation Dataset

This is the canonical test set for the hybrid-rag-podcasts system. Used for:

- **Manual smoke testing** during each phase
- **Ragas-style automated evaluation** starting in Phase 2
- **Regression testing** when retrieval logic changes

The questions are grouped by retrieval type. Each entry includes the **expected retrieval path** (which retriever should handle it) and **success criteria** (what a correct answer must include).

All questions are answerable from `data/sample-podcasts.csv` unless explicitly marked `[REFUSAL]` — those test the system's ability to decline rather than hallucinate.

---

## Category 1: Semantic queries (10)

These should be answered by **vector retrieval alone**. The information is in the transcripts but the wording in the question may not match the transcript verbatim.

| # | Question | Expected path | Success criteria |
|---|---|---|---|
| S1 | What did guests say about whether large language models are conscious? | vector | Cites Sarah Chen (ep_001) and Geoffrey Hinton (ep_015); contrasts their views |
| S2 | How do guests view the current state of brain-computer interfaces? | vector | Cites Aisha Patel (ep_003); mentions skepticism about Neuralink consumer claims |
| S3 | What concerns are raised about AI alignment progress? | vector | Cites Rodriguez (ep_002), Lindqvist (ep_007), Yamamoto (ep_013); covers multiple viewpoints |
| S4 | What are the views on whether AGI will arrive before 2035? | vector | Cites Rodriguez (ep_002) with the 20% figure; possibly Aschenbrenner contrast |
| S5 | How do guests describe the limitations of current multimodal models? | vector | Cites Bergstrom (ep_006); mentions "text models with vision encoders bolted on" |
| S6 | What is said about household robotics timelines? | vector | Cites Tanaka (ep_005); mentions twenty-year horizon and criticism of demos |
| S7 | What is the case for symbolic AI in 2024? | vector | Cites Hayes (ep_009); mentions neurosymbolic integration and interpretability |
| S8 | What concerns exist around the open weights vs closed model debate? | vector | Cites Sato (ep_008); mentions safety research argument |
| S9 | How is reinforcement learning's current direction described? | vector | Cites O'Sullivan (ep_010); "supervised learning with extra steps" |
| S10 | What hardware constraints do experts mention as limits on AI progress? | vector | Cites Krishnamurthy (ep_011); mentions memory bandwidth wall |

---

## Category 2: Filter queries (10)

These need **metadata filtering** in Chroma (Phase 1 supports this). The system uses metadata predicates to narrow the search space before similarity search.

| # | Question | Expected path | Success criteria |
|---|---|---|---|
| F1 | What did Stanford guests say about consciousness and embodied cognition? | vector + filter | Filter `guest_affiliation: "Stanford University"`; cites Chen and Müller |
| F2 | List the episodes featuring guests from MIT. | vector + filter | Filter `guest_affiliation: "MIT"`; returns Patel (ep_003) and Yamamoto (ep_013) |
| F3 | Which episodes are longer than two hours? | vector + filter | Filter `duration_min: { $gt: 120 }`; returns ep_001, ep_005, ep_007, ep_009, ep_015 |
| F4 | What did guests from Anthropic say? | vector + filter | Filter `guest_affiliation: "Anthropic"`; cites Rodriguez (ep_002) |
| F5 | List the episodes from 2024. | vector + filter | Filter `date >= "2024-01-01"`; multi-episode answer |
| F6 | What was discussed in episodes shorter than 90 minutes? | vector + filter | Filter `duration_min: { $lt: 90 }`; returns ep_004, ep_006, ep_008, ep_011 |
| F7 | What did the guest from NVIDIA discuss? | vector + filter | Filter `guest_affiliation: "NVIDIA"`; cites Krishnamurthy (ep_011) |
| F8 | What did guests with the role "Professor" cover? | vector + filter | Filter `guest_role` contains "Professor"; multi-episode |
| F9 | List episodes recorded between October 2023 and February 2024. | vector + filter | Filter on `date` range; returns ep_001, ep_002, ep_005, ep_007, ep_012 |
| F10 | What did independent researchers say? | vector + filter | Filter `guest_affiliation: "Independent Researcher"`; cites Lindqvist (ep_007) and Hinton (ep_015) |

---

## Category 3: Relational queries (10) — Phase 3+

These require **graph traversal** through the entity graph. Pure vector search cannot answer them reliably because the connections live in entity relationships, not in semantic similarity.

| # | Question | Expected path | Success criteria |
|---|---|---|---|
| R1 | Which guests have worked at OpenAI at some point in their career? | graph | Cypher traverses `WORKED_AT` to OpenAI; returns Rodriguez and Schulman |
| R2 | Who has collaborated with Geoffrey Hinton? | graph | `COLLABORATED_WITH` traversal; returns LeCun, Bengio (from ep_015) |
| R3 | List people connected to Stanford through any path. | graph | Multi-hop traversal; returns affiliated + visitors + collaborators |
| R4 | Which guests have a Stanford connection (current or past)? | graph | `AFFILIATED_WITH` or `WORKED_AT` or doctoral connection; multiple matches |
| R5 | Which companies appear most frequently in employment relationships? | graph | Aggregation over `WORKED_AT` edges; Google, OpenAI, Anthropic likely top |
| R6 | Who has worked with Sergey Levine? | graph | `COLLABORATED_WITH` traversal; returns O'Sullivan (ep_010) and Müller (ep_014) |
| R7 | List people mentioned in Sarah Chen's episode but not interviewed in their own. | graph | `MENTIONED_IN` from ep_001; returns Yamamoto, Tononi, Seth, Hinton |
| R8 | Which guests have moved between two or more major AI labs? | graph | Two-hop traversal of `WORKED_AT`; returns Rodriguez, Williamson, Sato, Hinton |
| R9 | Who has appeared in the podcast more than once? | graph | Count `FEATURES_GUEST` per Person; returns Yamamoto (ep_001 mention + ep_013) |
| R10 | Which guests share a doctoral advisor lineage? | graph | Trace `STUDIED_UNDER` edges if extracted; speculative — may not all be in data |

---

## Category 4: Hybrid queries (10) — Phase 4+

These require **graph filters first**, then **vector search inside the filtered subset**, OR **parallel retrieval** with merged context.

| # | Question | Expected path | Success criteria |
|---|---|---|---|
| H1 | What did former OpenAI employees say about alignment? | hybrid | Graph identifies ex-OpenAI persons (Rodriguez); vector searches their content for "alignment" |
| H2 | What did MIT-affiliated guests say about consciousness? | hybrid | Graph: MIT-affiliated persons; vector: "consciousness" in their statements |
| H3 | Among guests who collaborated with Sergey Levine, what did they say about robot learning? | hybrid | Graph: Levine collaborators; vector: "robot learning" in their content |
| H4 | What do former DeepMind researchers say about open-source AI? | hybrid | Graph: ex-DeepMind; vector: "open source" content |
| H5 | What is the view on hardware from people with industry experience? | hybrid | Graph: persons with industry affiliations; vector: "hardware" statements |
| H6 | Among guests on episodes over 2 hours, what was said about timelines? | hybrid | Filter + semantic: `duration > 120` + "timeline" |
| H7 | What did Anthropic guests say about scaling laws? | hybrid | Filter or graph: Anthropic; vector: "scaling laws" |
| H8 | What do guests who worked under Pieter Abbeel discuss? | hybrid | Graph: Abbeel students/postdocs; vector: their topics |
| H9 | What did interpretability researchers say about progress bottlenecks? | hybrid | Graph: persons working on interpretability; vector: "bottleneck" content |
| H10 | What concerns about AI risk did guests express who are also Turing Award recipients? | hybrid | Graph filter on role; vector: "AI risk" |

---

## Category 5: Refusal tests (5)

These test that the system **declines to answer** rather than hallucinating. The information is intentionally NOT in the dataset.

| # | Question | Expected behavior |
|---|---|---|
| X1 | What did Jeff Bezos say about Amazon's AI strategy in episode 20? | Refusal: "no episode 20 in context" |
| X2 | List all episodes featuring Sam Altman as a guest. | Refusal: Altman is mentioned but never a guest |
| X3 | What is the show's release schedule? | Refusal: metadata not in transcript content |
| X4 | What did the guest in episode 50 say about quantum computing? | Refusal: episode 50 does not exist |
| X5 | Who is the host of this podcast? | Refusal: host name not in any transcript |

---

## Category 6: Edge cases (5)

| # | Question | Expected behavior |
|---|---|---|
| E1 | (3-character question) "AI?" | Answer or graceful clarification; not crash |
| E2 | (Very long, multi-clause question, 450+ chars) "Considering everything that has been discussed across all episodes about the intersection of consciousness theories with modern transformer architectures, particularly in relation to integrated information theory, attention mechanisms, and the various skeptical positions held by guests from MIT, Stanford, and various commercial labs, what would be a synthesis of the dominant view in our dataset and where do the main points of disagreement lie?" | Comprehensive answer drawing from multiple chunks |
| E3 | (Non-ASCII characters) "Yapay zeka bilinçli mi?" | Answer in English (system default); should retrieve relevant chunks despite Turkish query |
| E4 | (Question that is semantically ambiguous) "What's the deal with AI?" | Reasonable answer or clarification request |
| E5 | (Question with no semantically close chunks) "What is the capital of France?" | Refusal: "not covered in podcast content" |

---

## How to use this file

### Phase 1 smoke test (manual)
Run all of Category 1 (Semantic) and 5 questions from Category 2 (Filter, if metadata filter is implemented). Document results in `docs/evaluation/phase-1-smoke-results.md`. Target: ≥ 80% return a grounded answer with correct citation.

### Phase 2 automated eval
Wire all questions into a Ragas evaluation pipeline. Track faithfulness, context_precision, context_recall per category. Establish baseline scores.

### Phase 3+ extensions
Add ground truth answer for each Category 3/4 question when entity extraction is stable. This enables `context_recall` calculation.

### Adding new questions
- Pick a category
- Number sequentially (S11, F11, R11, etc.)
- Specify expected retrieval path
- Define explicit success criteria — vague criteria invalidate the test