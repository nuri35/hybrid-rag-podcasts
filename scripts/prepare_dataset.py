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
result = pd.DataFrame({
    'episode_id':        grouped[COL_ID].astype(str),
    'title':             grouped[COL_TITLE],
    'date':              '',  # not in source
    'duration_min':      (grouped[COL_END] / 60).round().astype('Int64')
                          if COL_END in grouped.columns else '',
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
