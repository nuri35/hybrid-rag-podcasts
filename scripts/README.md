# scripts/

Data preparation tools for hybrid-rag-podcasts. **Dev-time only — not part of the runtime.**

## Contents

| File | Purpose |
|---|---|
| `prepare_dataset.py` | One-time download of the `nmac/lex_fridman_podcast` HuggingFace dataset, aggregates segment rows into per-episode transcripts, and writes `data/podcasts.csv` in this project's schema (`episode_id`, `title`, `date`, `duration_min`, `guest_name`, `guest_affiliation`, `guest_role`, `transcript_text`). |
| `requirements.txt` | Python deps for the script: `datasets`, `pandas`. |

## Usage

```bash
pip install -r scripts/requirements.txt
python scripts/prepare_dataset.py
# → data/podcasts.csv  (gitignored due to size)
```

After this, ingest into Chroma via the NestJS CLI:

```bash
npm run cli -- ingest --csv data/podcasts.csv --reset
```

## Why Python is here even though the project is TypeScript

Per `CLAUDE.md`, this project's runtime is TypeScript only — no Python sidecar, no FastAPI, no Python in the request path. This script is the **single exception**: a one-time, dev-time data preparation tool that runs once at clone time and never again. The HuggingFace `datasets` library is the path of least resistance for downloading and reshaping the source dataset; rewriting that in TypeScript would add complexity for no learning gain. The output is a plain CSV that the TypeScript ingestion pipeline consumes, so nothing else in the project depends on Python.

If you skip this script and use `data/sample-podcasts.csv` (which ships in git), you do not need Python at all.
