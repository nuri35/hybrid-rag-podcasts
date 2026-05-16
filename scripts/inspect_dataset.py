"""
One-time inspection of data/podcasts.csv to inform Phase 1.3 decisions
(chunking parameters, batch sizes, cost estimates).
"""
import pandas as pd
from pathlib import Path

CSV = Path('data/podcasts.csv')
assert CSV.exists(), f"Run prepare_dataset.py first; {CSV} missing"

df = pd.read_csv(CSV)
df['transcript_text'] = df['transcript_text'].astype(str)
df['text_len'] = df['transcript_text'].str.len()
df['word_count'] = df['transcript_text'].str.split().str.len()

print('=' * 60)
print(f'EPISODES: {len(df)}')
print('=' * 60)

print('\n-- Transcript length (characters) --')
print(f'  min    : {df.text_len.min():>12,}')
print(f'  median : {int(df.text_len.median()):>12,}')
print(f'  mean   : {int(df.text_len.mean()):>12,}')
print(f'  max    : {df.text_len.max():>12,}')
print(f'  total  : {df.text_len.sum():>12,}')

print('\n-- Transcript length (words) --')
print(f'  median : {int(df.word_count.median()):>12,}')
print(f'  mean   : {int(df.word_count.mean()):>12,}')
print(f'  total  : {df.word_count.sum():>12,}')

# Chunk projection at 800/100
effective = 800 - 100
chunks_per_episode = (df.text_len / effective).round().astype(int)
print('\n-- Projected chunks at chunk_size=800, overlap=100 --')
print(f'  per episode median : {int(chunks_per_episode.median()):>6}')
print(f'  per episode max    : {int(chunks_per_episode.max()):>6}')
print(f'  total chunks       : {chunks_per_episode.sum():>6,}')

# Cost estimate: text-embedding-3-small = $0.02 per 1M tokens, ~1.3 tokens/word
total_tokens = df.word_count.sum() * 1.3
cost_usd = total_tokens * 0.02 / 1_000_000
print('\n-- Embedding cost estimate (text-embedding-3-small) --')
print(f'  total tokens : {int(total_tokens):>12,}')
print(f'  cost USD     : ${cost_usd:.4f}')

print('\n-- Duration stats --')
print(f'  duration_min dtype : {df.duration_min.dtype}')
print(f'  median min         : {df.duration_min.median()}')
print(f'  mean min           : {df.duration_min.mean():.1f}')
print(
    f'  min / max          : {df.duration_min.min()} / {df.duration_min.max()}')

print('\n-- Quality checks --')
print(f'  empty transcripts        : {(df.text_len == 0).sum()}')
print(f'  under 1000 chars         : {(df.text_len < 1000).sum()}')
print(f'  over 200K chars          : {(df.text_len > 200_000).sum()}')
print(f'  unique guests            : {df.guest_name.nunique()}')
print(f'  duplicate episode_ids    : {df.episode_id.duplicated().sum()}')

print('\n-- Sample rows --')
for i in [0, 100, 200, 324]:
    if i < len(df):
        row = df.iloc[i]
        print(f'\n  Episode {row.episode_id}: {row.title[:60]}')
        print(f'    Guest: {row.guest_name}')
        print(f'    Duration: {row.duration_min} min')
        print(f'    Length: {row.text_len:,} chars / {row.word_count:,} words')
        print(f'    First 200 chars: {row.transcript_text[:200]}')
