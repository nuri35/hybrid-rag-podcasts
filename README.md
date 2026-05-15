# hybrid-rag-podcasts

A hybrid RAG (vector + graph) Q&A system over podcast transcripts. Users ask natural-language questions about podcast content; the system returns grounded answers with mandatory source attribution. Built as a portfolio artifact demonstrating AI-augmented backend engineering — combining NestJS, LangChain.js (LCEL), Chroma (vector store), and Neo4j (entity graph) in a single TypeScript service.

> The full project constitution — architectural decisions, hard constraints, conventions, and phase roadmap — lives in [`CLAUDE.md`](./CLAUDE.md). Read it first.

## Prerequisites

- Node.js >= 20 (developed on Node 24)
- npm 10+
- An OpenAI API key
- Chroma (Phase 1+): local server reachable at the configured `CHROMA_PATH` collection
- Neo4j (Phase 3+): community edition or Aura

## Install

```bash
npm install
```

## Environment setup

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

All env variables are validated at startup via a Zod schema (`src/common/config/env.schema.ts`). Missing or invalid env will fail boot fast with a descriptive error.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Runtime mode |
| `PORT` | no | `3000` | HTTP server port |
| `OPENAI_API_KEY` | yes | — | OpenAI credential |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | Generation model |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model |
| `CHROMA_PATH` | no | `./data/chroma` | Local Chroma collection path |
| `CHROMA_COLLECTION` | no | `podcasts` | Chroma collection name |

## Data preparation

This project requires a CSV of podcast transcripts before vector ingestion.

### Option 1 — Sample dataset (instant)

A 15-episode sample ships in `data/sample-podcasts.csv` for quick testing. Skip directly to "Usage".

### Option 2 — Full dataset (Lex Fridman podcast, 325+ episodes)

Run the one-time data prep script:

```bash
pip install -r scripts/requirements.txt
python scripts/prepare_dataset.py
```

This writes `data/podcasts.csv` (gitignored due to size). Python 3.9+ required. This is the only Python dependency in the project — used purely for one-time data preparation, not at runtime.

## Usage

### Step 1: Ingest the CSV into the vector store

```bash
# With sample
npm run cli -- ingest --csv data/sample-podcasts.csv --reset

# With full dataset (after data preparation)
npm run cli -- ingest --csv data/podcasts.csv --reset
```

> The `ingest` command lands in Phase 1.4. Until then, `npm run cli -- --help` lists the built-in CLI help.

### Step 2: Start the HTTP server

```bash
npm run start:dev
```

The server starts on `http://localhost:3000`. Health check:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

### Step 3: Ask questions

```bash
curl -X POST http://localhost:3000/api/v1/questions \
  -H 'Content-Type: application/json' \
  -d '{"question":"What did guests say about AGI?"}'
```

> The questions endpoint lands in Phase 1.7. Until then, only `/health` responds.

## Other scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run compiled HTTP server |
| `npm run lint` | ESLint (`no-explicit-any` and `no-floating-promises` are errors) |
| `npm run format` | Prettier write |
| `npm test` | Jest unit tests |

## Architecture overview

See [`CLAUDE.md`](./CLAUDE.md) for the authoritative architecture, foundation reasoning, hard constraints, and phase tracking. In short:

- **Single NestJS service** owns HTTP, CLI, and all LangChain orchestration. No Python sidecar.
- **LCEL composition** is mandatory for every retriever and chain.
- **Vector store (Chroma)** holds transcript chunks + metadata.
- **Graph store (Neo4j, Phase 3+)** holds the entity graph (Episode / Person / Company).
- **Bridge** between stores is shared identifiers (`episode_id`, `guest_name`).
- **Repository pattern** wraps every external client.

Skills under `.claude/skills/` enforce NestJS and LangChain.js conventions when working with Claude Code.
