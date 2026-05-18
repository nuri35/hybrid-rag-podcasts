# ADR 0005 — Segment-level rows must be sorted chronologically before groupby

- **Status:** Accepted
- **Date:** 2026-05-18
- **Scope:** `scripts/prepare_dataset.py` (data preparation tooling only)
- **Related:** ADR 0002 (CSV → Document mapping); ADR 0004 (text cleaning strategy); CLAUDE.md architectural decision #7 (Python is allowed only in `scripts/`).

---

## Context

The HuggingFace dataset `nmac/lex_fridman_podcast` is stored at segment granularity: each row is a short Whisper-transcribed clip with `id`, `title`, `guest`, `start`, `end`, `text` columns. To produce one row per episode for our CSV schema, `scripts/prepare_dataset.py` calls `pandas.DataFrame.groupby([id, title, guest]).agg(text=join)`.

`pandas.groupby` preserves the within-group row order during aggregation. It does **not** sort rows by any column unless explicitly told to. The HF dataset, in turn, returns segments in arbitrary order — there is no guarantee that consecutive rows of the same episode are chronologically adjacent.

The result: when we joined `text` cells with `' '.join(...)`, the joined transcript came out scrambled. Beginnings, middles, and ends of an episode were interleaved.

### How the bug surfaced

Phase 1.3.d introduced `TextCleanerService` with an outro-removal step. The cleaner scans for anchor phrases like `"Thank you for listening to this conversation with"` and, on a match, slices the text up to that index — assuming the outro always sits at the end. With unsorted segments, the outro phrase landed somewhere in the middle of the transcript. The cleaner then truncated everything after that mid-point, deleting ~30 KB of legitimate conversation per affected episode.

Symptoms observed during sanity inspection (Episode 101, Joscha Bach):

- Original last 400 chars showed mid-conversation dialogue (because the actual end was elsewhere in the scrambled order).
- The outro phrase appeared at byte 146,294 with the real conversation continuing for another ~30 KB beyond it.
- Dry-run on the full dataset reported a 20.0 % byte reduction after cleaning — most of which turned out to be silent data loss, not legitimate intro/outro stripping.

## Decision

Sort segment rows chronologically by `start` timestamp **within each episode** before the groupby aggregation.

Concrete change in `scripts/prepare_dataset.py`, placed immediately after `df = ds.to_pandas()` and constant setup, before the groupby:

```python
if COL_START in df.columns:
    print("Sorting segments by start timestamp for chronological order...")
    df['_start_sec'] = pd.to_numeric(
        df[COL_START].apply(parse_timestamp_to_seconds),
        errors='coerce',
    )
    df = df.sort_values([COL_ID, '_start_sec'], ascending=True, kind='stable')
    df = df.drop(columns=['_start_sec'])
else:
    print("Warning: 'start' column missing — skipping chronological sort.")
```

Implementation notes:

- We reuse the existing `parse_timestamp_to_seconds` helper added in the earlier `end`-column fix. It already handles both `HH:MM:SS.mmm` and `MM:SS.mmm` formats and returns `None` for invalid input.
- `pd.to_numeric(..., errors='coerce')` converts unparseable segments to `NaN`, which sort places at the end of the group — those rows aggregate last, which is acceptable since they are a rounding-error fraction of the data.
- `kind='stable'` preserves the original relative order of rows that share the same `(id, start_sec)` key.
- The temporary `_start_sec` column is dropped before groupby so it never appears in the output CSV.
- The defensive `if COL_START in df.columns` check keeps the script working if the source schema ever drops the column (with a warning instead of a crash).

## Alternatives considered

### A. Make `TextCleanerService` tolerant of mid-transcript outro matches

**Rejected.** Asking the cleaner to second-guess anchor positions (e.g., "only trust the anchor if it appears in the last 20 % of the text") would (1) introduce magic thresholds, (2) still produce wrong results on long episodes where the heuristic boundary is misplaced, and (3) shift the responsibility of correctness from data prep to runtime. The clean fix is to give the cleaner correctly-ordered text.

### B. Sort at ingestion time inside `CsvLoaderService`

**Rejected.** By the time the CSV is loaded, segment boundaries are already lost — we have one giant `transcript_text` per episode. There is no information to sort. The fix must live upstream, in the script that has access to segment-level rows.

### C. Switch from `pandas.groupby` to an explicit per-episode loop with manual sorting

**Rejected.** It works but adds boilerplate and is slower for no clarity gain. Pandas with `sort_values` then `groupby` is idiomatic and concise.

## Consequences

### Positive

- Joined transcripts are now in chronological order, matching audio playback order.
- `TextCleanerService.removeOutro` now finds the outro anchor at the actual end and slices correctly. Sanity inspection on episodes 264 (Tim Urban) and 319 (Botez Sisters) confirmed that "BEFORE last 500 chars" now shows the genuine outro/sponsor read, and "AFTER last 500 chars" shows the natural closing words of the interview.
- Total byte reduction from cleaning dropped from a fake 20.0 % to a genuine ~1.3 %. Chunks produced rose from 43,366 back up to 53,427 (close to the no-cleaning baseline of 54,049). The ~600-chunk gap represents real intro/outro/sponsor content that the cleaner correctly removes.

### Negative / trade-offs

- One-time cost: existing `data/podcasts.csv` files generated by the broken script are invalid and must be regenerated. The script is idempotent so this is a single delete + re-run.
- `parse_timestamp_to_seconds` is now called twice per row (once for the sort, once already for `duration_min` after groupby). The script's runtime is dominated by I/O and groupby; the doubled parser call is not a measurable hit on a 803 K-row dataframe.
- The sort assumes `start` is a usable chronological key within an episode. If a future dataset re-encoded the column inconsistently (e.g., per-segment second-counter that resets), this assumption would break. We accept that risk for the current HF dataset; the defensive `if COL_START in df.columns` plus a future schema-validation step would catch a regression.

### Lesson for future data prep work

Pandas group-and-aggregate operations preserve row order. They do not impose chronological ordering. Whenever the output's semantic correctness depends on within-group ordering (text joining, time-series resampling, sequence-sensitive features), sort explicitly first — do not trust the source.

## Verification trail

1. `python scripts/inspect_dataset.py` — episode count and stats unchanged (319 episodes, duration 33–315 min).
2. `npm run cli -- ingest --csv data/podcasts.csv --dry-run` — `chunksProduced` rose from 43,366 → 53,427; `bytesAfterCleaning` rose from 30,281,593 → 37,326,252 (cleaning now removes only the real outro, not legitimate content).
3. `npx ts-node -r tsconfig-paths/register scripts/inspect_cleaning.ts` — for Episodes 264 and 319, "BEFORE last 500 chars" now shows the genuine outro text, "AFTER last 500 chars" shows the natural interview ending. The previous mismatch (mid-conversation content in BEFORE-last, conversational closing in AFTER-last) is gone.
