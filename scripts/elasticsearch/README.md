# Elasticsearch — Keyword (BM25) Side of Hybrid Retrieval

Operational toolkit for the Elasticsearch half of Phase 4 hybrid retrieval.
Everything here is **dev-time Python tooling** (same carve-out as `scripts/prepare_dataset.py`
and `evaluation/`) — production keyword search is called from NestJS via
`@elastic/elasticsearch` in Phase 4.2, not from these scripts.

## 1. Overview

Phase 4 fuses two retrievers and ranks the union with Reciprocal Rank Fusion (RRF):

| Side | Store | Strength | Role |
|------|-------|----------|------|
| Vector | **Chroma** (`podcasts`) | semantic similarity | **source of truth** |
| Keyword | **Elasticsearch** (`podcast_chunks`) | exact terms, rare/coined vocabulary | derived, rebuildable |

Elasticsearch exists to catch the queries pure vector embeddings miss — specific
terminology like *"Turing machine"* or *"constructors vs abstractors"* (the 4 zero-hit
baseline questions q006/q012/q014/q017). The two stores are bridged by `chunk_id`:
the same id is the Chroma document id and the ES `_id`, so results from both sides
refer to the same chunk and can be fused.

Files in this directory:

| File | Purpose | Sub-phase |
|------|---------|-----------|
| `mappings/podcast_chunks.json` | Index settings + field mapping (English analyzer) | 4.1.2 |
| `create-index.py` | Create / recreate the index | 4.1.3 |
| `ingest-chunks.py` | Bulk-copy chunks Chroma → ES (idempotent) | 4.1.4 |
| `smoke-test.py` | 8-check verification suite (re-runnable) | 4.1.5 |

The index uses Elasticsearch's built-in **`english` analyzer** (lowercasing,
English stopword removal, Porter stemming). `text` is the only analyzed field;
all metadata fields are `keyword` (exact) or `integer`.

## 2. Quick start

From the repo root with the virtualenv active (`.venv`):

```bash
docker-compose up -d elasticsearch                      # 1. start the cluster
python scripts/elasticsearch/create-index.py            # 2. create the index
python scripts/elasticsearch/ingest-chunks.py           # 3. fill it from Chroma (~15s)
python scripts/elasticsearch/smoke-test.py              # 4. verify
```

On Windows use `.\.venv\Scripts\python.exe` instead of `python`.

Prerequisites: Chroma must already be ingested (`docker-compose up -d chroma` +
the NestJS ingestion CLI). ES ingestion reads from Chroma, so an empty Chroma
means an empty ES index.

## 3. Sync strategy

**Manual + sequential. One-way: Chroma → ES.**

1. The TypeScript ingestion pipeline fills **Chroma first** — Chroma is the source
   of truth (it holds the vectors and the canonical chunk text).
2. `ingest-chunks.py` is then run **by hand** to derive the ES index from Chroma.
3. Re-running is safe: `chunk_id` is the ES `_id`, so writes overwrite in place
   and never duplicate. The script doubles as a re-sync tool.

**Why no auto-trigger in Phase 4?** ES is rebuildable derived data, not a primary
store. A 15-second manual rebuild is simpler and more observable than wiring an
event-driven sync, and Phase 4 is a static dataset. Event-driven sync (re-index
on Chroma write) is noted as a future option (§7).

## 4. Consistency

`ingest-chunks.py` ends with a count comparison: **Chroma count vs ES count**.

- **Match** (e.g. `53427 == 53427`) → success, exit 0.
- **Mismatch** → loud warning, the failed `chunk_id`s are listed, exit 1.

A mismatch means some chunks failed to index (mapping rejection, transient ES
error) or Chroma changed mid-run. The fix is almost always a clean rebuild (§5) —
because ingestion is idempotent, re-running cannot make things worse.

`smoke-test.py` Check 2 re-verifies the same count equality independently any time.

## 5. Recovery — full rebuild

ES holds no unique data; it is always reconstructable from Chroma in ~15 s:

```bash
python scripts/elasticsearch/create-index.py --force    # drop + recreate (empty)
python scripts/elasticsearch/ingest-chunks.py           # refill from Chroma
python scripts/elasticsearch/smoke-test.py              # confirm
```

There is **no data-loss risk** in deleting the ES index — only Chroma loss would
matter, and Chroma has its own persistent volume. If the whole ES volume is wiped,
just re-run create-index + ingest.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker-compose ps elasticsearch` not `healthy` | Cluster still booting (~30-60 s) or low memory | Wait, then `curl localhost:9200/_cluster/health`; check `ES_JAVA_OPTS` heap fits RAM |
| `index 'podcast_chunks' does not exist. Run create-index.py first` | Index never created or was `--force`-dropped | Run `create-index.py` |
| `PermissionError` / SSL cert error on Chroma connect | `SSL_CERT_FILE` (or `SSL_CERT_DIR` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`) points at an unreadable file; httpx loads it eagerly | The scripts already clear these vars around the Chroma client. If you hit it elsewhere, `unset SSL_CERT_FILE` (bash) / `$env:SSL_CERT_FILE=$null` (PowerShell) |
| `Cannot connect to Elasticsearch` | Cluster down | `docker-compose up -d elasticsearch` |
| Count mismatch at end of ingestion | Some chunks rejected, or Chroma changed mid-run | Full rebuild (§5); inspect the listed failed `chunk_id`s |
| Chroma count is 0 | Chroma not ingested | Run the NestJS ingestion CLI first |

## 7. Known limitations

- **Single-node dev cluster.** `discovery.type=single-node`, 1 shard, 0 replicas —
  no high availability. Fine for a portfolio dataset; production would add nodes
  and replicas.
- **Security disabled (DEV ONLY).** `xpack.security.enabled=false` — no TLS, no auth.
  Never ship this configuration to production; enable xpack security + TLS +
  credentials there.
- **Manual sync.** No automatic re-index when Chroma changes. Acceptable for a
  static dataset. **Future option:** event-driven sync (re-index a chunk on Chroma
  write) if the dataset ever becomes live-updating.
- **512 MB JVM heap.** Sized for ~53k chunks. Scale `ES_JAVA_OPTS` for larger corpora.
