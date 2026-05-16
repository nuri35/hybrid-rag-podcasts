"""
One-time data preparation script.

Downloads the nmac/lex_fridman_podcast dataset from HuggingFace,
aggregates segment-level rows into per-episode transcripts,
and writes data/podcasts.csv in the schema used by hybrid-rag-podcasts.

Run once after cloning the repo if you want to use the full dataset
instead of the sample. The output is gitignored.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/prepare_dataset.py
"""
from datasets import load_dataset
import pandas as pd
from pathlib import Path


def parse_timestamp_to_seconds(ts):
    """Convert an HF Lex Fridman `end` timestamp into float seconds.

    The HuggingFace source stores `end` as a colon-delimited string in one
    of two formats:
        "HH:MM:SS.mmm"  (long segments, e.g. "01:23:45.500" -> 5025.5 s)
        "MM:SS.mmm"     (short segments, e.g. "04:12.300"   ->  252.3 s)

    Earlier code assumed `end` was a numeric seconds value and crashed with
    TypeError when dividing a string by 60. DO NOT remove this parser - the
    column is a string in the source dataset and must be parsed before any
    numeric arithmetic.

    Returns float seconds, or None for empty/unparseable values. The caller
    pipes through pd.to_numeric(..., errors='coerce') so None becomes NaN
    which then survives .astype('Int64') as pd.NA.
    """
    if ts is None:
        return None
    if isinstance(ts, float) and pd.isna(ts):
        return None
    text = str(ts).strip()
    if not text:
        return None
    parts = text.split(':')
    try:
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        if len(parts) == 2:
            minutes, seconds = parts
            return int(minutes) * 60 + float(seconds)
    except (ValueError, TypeError):
        return None
    return None


print("Loading dataset from HuggingFace...")
ds = load_dataset("nmac/lex_fridman_podcast", split="train")
df = ds.to_pandas()
print(f"Loaded {len(df)} rows")
print(f"Columns in source: {list(df.columns)}")

# Source schema (per HF dataset card): id, title, guest, start, end, text
COL_ID, COL_TITLE, COL_GUEST = 'id', 'title', 'guest'
COL_TEXT, COL_END = 'text', 'end'

print("Aggregating segments into per-episode transcripts...")
agg = {COL_TEXT: lambda parts: ' '.join(parts.tolist())}
if COL_END in df.columns:
    agg[COL_END] = 'max'

group_cols = [c for c in [COL_ID, COL_TITLE, COL_GUEST] if c in df.columns]
grouped = df.groupby(group_cols, as_index=False).agg(agg)

print("Mapping to project schema...")

# `end` is a string timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm"), not seconds.
# Parse into float seconds, coerce unparseable rows to NaN, then derive
# duration_min as nullable Int64 so pd.NA survives the CSV write.
if COL_END in grouped.columns:
    end_seconds = pd.to_numeric(
        grouped[COL_END].apply(parse_timestamp_to_seconds),
        errors='coerce',
    )
    duration_min = (end_seconds / 60).round().astype('Int64')
else:
    duration_min = ''

result = pd.DataFrame({
    'episode_id':        grouped[COL_ID].astype(str),
    'title':             grouped[COL_TITLE],
    'date':              '',  # not in source
    'duration_min':      duration_min,
    'guest_name':        grouped[COL_GUEST] if COL_GUEST in grouped.columns else '',
    'guest_affiliation': '',  # not in source — filled by LLM extraction in Phase 3
    'guest_role':        '',  # not in source
    'transcript_text':   grouped[COL_TEXT],
})

output = Path('data/podcasts.csv')
output.parent.mkdir(parents=True, exist_ok=True)
result.to_csv(output, index=False)
print(f"Wrote {len(result)} episode rows to {output}")
print("Done. Now run: npm run cli -- ingest --csv data/podcasts.csv --reset")
