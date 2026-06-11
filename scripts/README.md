# scripts/

Data preparation tools for hybrid-rag-podcasts. **Dev-time only — not part of the runtime.**

## Contents

| File | Purpose |
|---|---|
| `prepare_dataset.py` | One-time download of the `nmac/lex_fridman_podcast` HuggingFace dataset, aggregates segment rows into per-episode transcripts, and writes `data/podcasts.csv` in this project's schema (`episode_id`, `title`, `date`, `duration_min`, `guest_name`, `guest_affiliation`, `guest_role`, `transcript_text`). |
| `requirements.txt` | Python deps for the script: `datasets`, `pandas` (plus transitive `huggingface_hub`, `pyarrow`, etc.). |
| `elasticsearch/` | **Phase 4 (Hybrid Retrieval) keyword-search tooling.** Manually-run, dev-time Python scripts that create the `podcast_chunks` Elasticsearch index and copy chunks into it from Chroma for BM25 search. These are operational tools, **not** part of the NestJS runtime (production keyword search is called from NestJS via `@elastic/elasticsearch` in Phase 4.2). Run order and full ops docs: **[`elasticsearch/README.md`](elasticsearch/README.md)**. |

> **All scripts in this directory are run manually.** Nothing here is auto-triggered
> by the app — they are one-time / on-demand dev-time tools. The Elasticsearch index
> is rebuildable derived data: fill Chroma first (via the NestJS ingestion CLI), then
> run the `elasticsearch/` scripts by hand to sync. See `elasticsearch/README.md` § "Sync strategy".

## Prerequisites

- **Python ≥ 3.9** (developed on 3.10). Verify with `python --version`.
- **`pip`** on the same Python (`python -m pip --version`). If missing: `python -m ensurepip --upgrade`.
- **~300 MB free disk**: ~215 MB for the HuggingFace dataset cache (`~/.cache/huggingface/`), ~40 MB for the generated CSV, and ~250 MB for installed Python dependencies.
- **Internet** for the first run (subsequent runs use the local HF cache).
- **No HuggingFace account needed** — `nmac/lex_fridman_podcast` is a public dataset.

## Recommended workflow (with virtual environment)

Strongly recommended: keep these one-time dependencies isolated from your global Python.

**Windows PowerShell:**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r scripts/requirements.txt
python scripts/prepare_dataset.py
deactivate                              # optional, when done
```

If activation fails with an execution-policy error, run once per user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Windows cmd.exe:**

```cmd
python -m venv .venv
.venv\Scripts\activate.bat
pip install -r scripts\requirements.txt
python scripts\prepare_dataset.py
deactivate
```

**macOS / Linux:**

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/prepare_dataset.py
deactivate
```

The `.venv/` directory is gitignored.

## Without a virtual environment (not recommended)

```bash
pip install -r scripts/requirements.txt
python scripts/prepare_dataset.py
```

This works but pollutes your global Python with dataset-handling libraries you only need once.

## After running

```bash
npm run cli -- ingest --csv data/podcasts.csv --reset
```

(The `ingest` command itself lands in Phase 1.4 — at that point the CSV is already on disk and waiting.)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'huggingface_hub'` | Half-installed deps. Re-run `pip install -r scripts/requirements.txt` inside the activated venv. |
| `TypeError: unsupported operand type(s) for /: 'str' and 'int'` | The source `end` column is a string timestamp, not seconds. The script handles this via `parse_timestamp_to_seconds`. If you hit this, you have a stale copy of the script — pull latest. |
| `pip` not found | `python -m ensurepip --upgrade`, or reinstall Python with the "Add to PATH" + "pip" options checked. |
| PowerShell blocks venv activation | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. |
| Network timeout on first run | Initial download is ~215 MB. Re-run when connection is stable; cache resumes. |
| Want to re-download fresh | Delete `~/.cache/huggingface/datasets/nmac___lex_fridman_podcast` and re-run. |

## Why Python is here even though the project is TypeScript

Per `CLAUDE.md`, this project's runtime is TypeScript only — no Python sidecar, no FastAPI, no Python in the request path. This script is the **single exception**: a one-time, dev-time data preparation tool that runs once at clone time and never again. The HuggingFace `datasets` library is the path of least resistance for downloading and reshaping the source dataset; rewriting that in TypeScript would add complexity for no learning gain. The output is a plain CSV that the TypeScript ingestion pipeline consumes, so nothing else in the project depends on Python.

If you skip this script and use `data/sample-podcasts.csv` (which ships in git), you do not need Python at all.
