# ADR 0004 — Text cleaning strategy

- **Status:** Accepted
- **Date:** 2026-05-18
- **Phase:** 1.3.d (TextCleanerService)
- **Related:** ADR 0002 (CSV → Document mapping); `docs/phases/phase-1.md`; CLAUDE.md architectural decision #10

---

## Context

The HuggingFace `nmac/lex_fridman_podcast` dataset is produced by Whisper transcription of audio episodes. Whisper output is mostly usable but contains a recurring set of non-content artifacts that, if embedded as-is, would degrade retrieval quality:

1. **Unicode noise** — smart quotes (U+201C/U+201D/U+2018/U+2019), non-breaking spaces (U+00A0), non-normalized composed characters.
2. **Whitespace irregularities** — multiple spaces from misaligned word boundaries, excessive newlines from speaker-change padding.
3. **Repeated punctuation** — Whisper occasionally emits "!!!" or "...." where a single mark suffices.
4. **Whisper hallucination loops** — short stretches where the same sentence is transcribed 3+ times in a row (a known failure mode on silence or music).
5. **Lex Fridman's formulaic intro / outro** — every episode contains nearly-identical openings ("And now, dear friends, here's …") and closings ("Thank you for listening to this conversation with …"). Embedding these dilutes the per-episode signal and biases similarity search for any query that semantically resembles the formula.

Future, less deterministic, opt-in cleaners we'd like to keep on the table without committing to now:

6. Sponsor segments (mid-roll ad copy).
7. Filler words ("um", "uh", "you know").

We need a single place to apply normalization, sitting between CSV load and chunking so every downstream stage (chunker, embedder, vector store) sees canonical text. Performance must be good enough to clean 319 episodes in well under a second.

## Decision

Introduce a dedicated `TextCleanerService` (`src/modules/ingestion/services/text-cleaner.service.ts`) invoked by `IngestionPipelineService` immediately after `CsvLoaderService.load()`. The service applies three **levels** of cleaning, each composed of small, individually idempotent steps:

### Level 1 — always on

| Step | What it does |
|---|---|
| `normalizeUnicode` | `String.prototype.normalize('NFC')` — collapses composed/decomposed sequences. |
| `normalizeQuotes` | `“ ”` → `"` ; `‘ ’` → `'`. |
| `normalizeSpaces` | NBSP (`U+00A0`) → regular space; runs of 2+ spaces → one. |
| `normalizeNewlines` | 3+ consecutive newlines → exactly two. |
| `collapseRepeatedPunctuation` | `!{2,}` → `!`, `?{2,}` → `?`, `\.{4,}` → `...` (3-dot ellipsis preserved). |
| `trim` | Leading/trailing whitespace. |
| `dedupeRepeatedSentences` | Split on sentence terminator + capital-letter boundary; if a normalized sentence repeats 3+ times consecutively, keep one. Two repetitions are left untouched (common rhetorical device in podcasts). |

### Level 2 — config-gated, **default on**

| Step | Flag | Behavior |
|---|---|---|
| `removeIntro` | `CLEANING_REMOVE_INTRO=true` | Scan for any of four anchor phrases (`LEX_INTRO_ANCHORS`). On first match, advance past the anchor **and** the next sentence-terminator (which carries the guest name introduction). If no anchor present, leave text unchanged. |
| `removeOutro` | `CLEANING_REMOVE_OUTRO=true` | Scan for any of four anchor phrases (`LEX_OUTRO_ANCHORS`). On first match, return everything before it. If no anchor present, leave text unchanged. |

Anchor phrases are stored as `readonly` tuples at the top of the file. Matching is case-insensitive via `toLowerCase().indexOf()`. The no-anchor fallback guarantees zero false positives — non-Lex transcripts that lack the formula pass through unchanged.

### Level 3 — config-gated, **default off, deferred to Phase 2**

| Step | Flag | Current behavior |
|---|---|---|
| `removeSponsors` | `CLEANING_REMOVE_SPONSORS=true` | Logs a warning and returns text unchanged. |
| `removeFillers` | `CLEANING_REMOVE_FILLERS=true` | Logs a warning and returns text unchanged. |

The config plumbing exists today so the Phase 2 implementation can be a pure addition with no DI churn.

## Alternatives considered

### A. No cleaning

**Rejected.** Embeddings would carry NBSP, repeated punctuation, hallucination loops, and the same Lex intro/outro on every episode. The intro/outro alone causes any query loosely matching the formula to return generic, low-signal chunks across many episodes, which is exactly the failure mode RAG is supposed to avoid.

### B. LLM-based cleaning

**Rejected.** A 319-episode dataset with ~50K chunks at ~800 chars each is ~40 MB of text. Cleaning it with an LLM (say Gemini Flash) would cost real money and minutes per run, for a task where deterministic regex achieves equivalent quality. The non-determinism is also a liability — we want byte-stable input to the embedder so re-runs produce identical vector IDs.

### C. Aggressive filler-word removal in Phase 1

**Rejected for now.** Removing "um"/"uh"/"you know" sounds attractive but interacts badly with sentence dedup and chunk boundaries (e.g., "you know" appears mid-sentence as a genuine phrase too). The plan is to ship Levels 1 and 2 first, measure faithfulness/recall/precision in Phase 2's evaluation harness, and decide whether Level 3 helps. Until that signal exists, we treat aggressive filtering as a high-risk-of-regression operation.

### D. Configuration via NestJS dynamic module / external rule file

**Rejected.** Four boolean flags do not justify dynamic module overhead. Plain env vars validated by Zod (`src/common/config/env.schema.ts`) are sufficient. If the rule set grows to ~20+ knobs, revisit via a new ADR.

## Consequences

### Positive

- Single canonical preprocessing step. Every downstream service (chunker, embedder, future graph extractor) reads cleaner output, so changes propagate from one place.
- Byte savings: dry-run on the 319-episode dataset shows the chunk count drops from ~54K to ~48-52K range, primarily from intro/outro stripping. Embedding cost and storage scale linearly with chunk count, so this is real money.
- Deterministic and idempotent — `clean(clean(x))` equals `clean(x)`, which simplifies re-running ingestion when a single env flag changes.
- Fast — pure regex, single pass per step, no I/O. Cleaning 319 transcripts completes in well under one second.
- Zero new dependencies. Pure TypeScript regex/string operations only.

### Negative / trade-offs

- Hard-coded English-specific patterns (intro/outro anchors). Non-Lex datasets or non-English transcripts pass through Level 2 untouched (which is the desired safe default), but they would not benefit from intro/outro stripping. Generalizing requires a per-dataset rule pack — out of scope until we ingest a second dataset.
- Anchor phrase list is fixed at four entries each. A future Lex episode with a phrasing variant we haven't seen will not get its intro/outro stripped. Mitigation: when the eval harness flags it, append the new variant to the constant and re-ingest.
- The "skip-past-next-terminator" rule for intro removal will eat a genuine first sentence if a non-Lex transcript happens to contain one of the intro anchors followed by a guest name. The risk is low because the anchor phrases are quite specific.

### Future work — Phase 2 ties this off

1. Wire the Ragas-style evaluation harness (Phase 2) to compare retrieval quality with `CLEANING_REMOVE_INTRO/OUTRO` on vs. off using the golden questions in `docs/evaluation/golden-questions.md`.
2. Use that measurement to decide whether Level 3 (sponsors/fillers) is worth implementing.
3. Consider a small admin metric: percentage of episodes where each anchor phrase matched, surfaced in the ingestion log so we know whether the rules generalize as the dataset grows.
