# ADR 0006 — ChromaRepository design (production-grade)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Phase:** 1.3.e — Vector storage layer
- **Related:** ADR 0002 (CSV → Document mapping), ADR 0004 (text cleaning), CLAUDE.md architectural decisions #3 (hybrid retrieval), #9 (Gemini embeddings), #11-14 (Chroma deployment, idempotency, write concurrency, production readiness).

---

## Context

Phases 1.3.a–d produce clean, chunked, Gemini-embedded vectors. We now need a storage layer that:

1. Persists vectors and per-chunk metadata.
2. Survives unchanged across **all** deployment topologies — same-host Docker, different-VM same-datacenter, Chroma Cloud, future regions — with tuning expressed only as env vars.
3. Behaves reliably under transient network errors and rate limits, without partial-success surprises.
4. Fails fast at boot if the server is unreachable, instead of partway through an expensive embedding pass.
5. Is idempotent: re-running ingestion must overwrite cleanly, not duplicate.
6. Stays under our hard constraint "wrap external clients in a Repository" (CLAUDE.md).

## Decision

A `ChromaRepository` (`src/common/repositories/chroma.repository.ts`) that wraps the raw `chromadb` JS client. Nine properties drive the design:

1. **Server runs as a `docker-compose`-managed container** (`docker-compose.yml`). Pinned image `chromadb/chroma:0.5.23`. Healthcheck via `curl /api/v1/heartbeat` every 10 s. Persistent volume to `./data/chroma/` (gitignored). Same compose file in dev and production.
2. **Raw `chromadb` JS client, no LangChain wrapper.** The LangChain Chroma vector-store wrapper forces an `embeddingFunction` callback, which would re-embed during writes. We supply pre-computed Gemini vectors and need direct control over `upsert(ids, embeddings, metadatas, documents)`.
3. **Configurable write batches.** Default `CHROMA_WRITE_BATCH_SIZE=500` (tunable 1–5000). 500 balances HTTP overhead against blast radius on a failed batch.
4. **Configurable concurrency via `p-limit`** — default `CHROMA_WRITE_CONCURRENCY=3`. The pattern mirrors Pinecone's `pool_threads`: a semaphore that throttles in-flight HTTP requests. Local Chroma serializes HNSW updates server-side, so concurrency provides no local speedup; it does help in remote deployments where network latency dominates.
5. **Idempotent upsert.** `collection.upsert(...)` with deterministic `chunk_id` (set in 1.3.b: `${episode_id}_chunk_${idx}`). Re-runs overwrite. `--reset` flag wipes the collection first when a clean state is required.
6. **Retry-with-backoff inside the batch.** `writeBatchWithRetry` attempts up to `CHROMA_WRITE_MAX_RETRIES` (default 3) with `1s → 2s → 4s` exponential backoff and ±200 ms jitter, but only for transient errors (HTTP 429, 5xx, timeouts, `ECONNRESET`, etc.). Non-transient errors (4xx validation, auth) fail fast — no point retrying.
7. **Per-batch timeout via `withTimeout` wrapper.** Default 30 s (tunable). We do **not** attach a shared `AbortSignal` to the client's `fetchOptions` because the same `RequestInit` is reused on every call — a single shared signal fired by the first long call would abort every subsequent call. The wrapper handles this correctly per call.
8. **Atomic operation-level failure.** `Promise.allSettled` runs all batch tasks; if any rejected after retries, the repository throws `ChromaWriteFailedException` with `writtenBatches`, `failedBatches[]`, `totalBatches`. The caller learns exactly which batches survived — no silent partial success.

9. **Vector normalization for metric-agnostic retrieval.** Chroma 0.5.x's JS client (1.10.x) does not expose the new Configuration API for distance metrics; `metadata['hnsw:space']` is silently ignored server-side, and a direct POST to `/api/v2/.../collections` with a `configuration` field requires Pydantic-internal `_type` discriminator fields that are not part of the documented API and fail with `HTTP 500 KeyError('_type')`. Instead of fighting this, we **normalize all vectors to unit length at embed time**. For unit vectors, L2 distance ranking is mathematically equivalent to cosine similarity ranking — proof: `cos(a, b) = 1 - L²(a, b) / 2` when `||a|| = ||b|| = 1`. Chroma's default L2 metric therefore produces cosine-equivalent results without any server configuration. Trade-off: one extra O(d) pass per vector (~768 multiplications, microseconds). Benefit: implementation is robust across Chroma versions, requires no internal-API hacking, and is a standard production pattern (Sentence Transformers, OpenAI's official client, and Pinecone documentation all recommend or use this). Query-time normalization is the responsibility of the retriever (Phase 1.5) — query vectors must also be unit-normalized before passing to `similaritySearch`. Normalization is applied via L2 unit-normalization in `EmbedderService.normalizeVector` and verified in tests with realistic Gemini-magnitude inputs (per-dimension ~10⁻²–10⁻¹, magnitude in the 0.05–2.0 range); the zero-vector edge case uses a `magnitudeSquared < 1e-12` threshold (i.e. magnitude below 1e-6) so genuine Gemini values are never misclassified.

Auth for Chroma Cloud is plumbed through optional `CHROMA_API_KEY` + `CHROMA_API_KEY_HEADER` env vars (default header `X-Chroma-Token`), injected via `fetchOptions.headers`. Local Chroma ignores the header.

Health check runs in `onModuleInit()` via `client.heartbeat()` wrapped in a short 5 s timeout. Failure throws `ChromaUnreachableException` and aborts ingestion before any embedding cost is incurred.

Graceful shutdown is wired via `OnModuleDestroy` (logs a clean shutdown message) plus `SIGINT`/`SIGTERM` handlers in `src/main.ts` and `src/cli.ts`. In-flight upserts settle naturally through `Promise.allSettled`; we do not force-cancel mid-batch.

## Alternatives considered

### A. LangChain Chroma vector-store wrapper

**Rejected.** Forces an embedding function on the collection, which interferes with our pre-computed-vector flow. Adds an indirection layer with no benefit, and ties us to LangChain's release cadence for a thin transport.

### B. Sequential-only writes (concurrency = 1)

**Rejected as default.** Works perfectly for local Chroma (server-side HNSW serializes anyway) but leaves 15–33 % throughput on the table for remote deployments. We pay nothing for `concurrency=3` locally and gain real headroom remotely. Pinecone settled on the same "pool of workers" pattern for the same reason.

### C. High default concurrency (10+)

**Rejected as default.** Local Chroma's single-writer HNSW becomes the bottleneck around 3-5; further parallelism just queues server-side. Cloud deployments do benefit from higher concurrency, which is why we expose the knob via env. Default favors the most common case (local) without harming the others.

### D. Smaller batches (100)

**Rejected.** Same total vectors but ~5× the HTTP overhead. No measurable benefit.

### E. Larger batches (2000+) as default

**Rejected as default.** Bigger payloads work in production (especially Cloud) but increase the blast radius when a batch fails — 2000 vectors gone vs. 500. Default to 500; bump via env when network round-trips dominate.

### F. Streaming embed/write overlap

**Deferred to Phase 1.3.f** (kept in CLAUDE.md "Future optimizations"). Streaming the embedder's output into the writer's input would overlap network waits and likely shave 30 % off total ingestion time on the full dataset. The current batch-then-write architecture is observable, easier to reason about, and good enough; revisit after Phase 2 evaluation establishes a baseline.

## Consequences

### Positive

- Same code, same config file, three deployment topologies (local Docker, intra-DC VM, Chroma Cloud) — tuning is env-only.
- Health check at module init prevents partial ingestion against a dead server, saving Gemini quota.
- Retry-with-backoff absorbs transient network blips and 429s without operator intervention.
- Structured logs (`chroma_write_complete`, `chroma_batch_retry`) play well with log aggregators (Loki, CloudWatch, Datadog).
- Idempotent re-runs: same `chunk_id` overwrites, so failed mid-runs can be re-run without `--reset`.
- Per-batch diagnostics on failure: `ChromaWriteFailedException.failedBatches[]` carries `{index, reason}` for each rejected batch.

### Negative / trade-offs

- The shared-`AbortSignal` chromadb-client wart means we cannot use the canonical `fetchOptions.signal` pattern. The `withTimeout` wrapper is a workaround. If chromadb later supports per-call options, simplify.
- The default embedding function on `getOrCreateCollection` is `DefaultEmbeddingFunction` — its `.generate()` would attempt to download `@xenova/transformers` if ever invoked. We intentionally never trigger it (we always supply embeddings), but the comment in `getOrCreateCollection()` calls this out explicitly.
- Concurrency defaults are calibrated for typical local + intra-DC deployments. Chroma Cloud users **must** raise `CHROMA_WRITE_CONCURRENCY` to get good throughput — documented in the README "Production deployment" section.
- The custom retry distinguishes transient vs. permanent via error message scan for HTTP codes. If a Chroma server ever responds with non-standard error envelopes, classification could drift. Coverage of common codes (429/5xx/timeout/ECONNRESET) is adequate for the deployment matrix we target.
- `configuration_json.hnsw_configuration.space` on the server will show `"l2"` after a fresh collection creation — this is **correct and intentional**. Equivalence to cosine is guaranteed by upstream vector normalization in `EmbedderService`, not by server-side configuration. No verification on the Chroma side is needed beyond confirming the collection exists.
- The retriever (Phase 1.5) must normalize query vectors before calling `similaritySearch`. This contract is enforced at the retriever boundary — `ChromaRepository.similaritySearch` itself does not normalize, because it has no way to know whether a caller already normalized; double-normalization of an already-unit vector is a no-op but still wasteful at scale.
- If a future chromadb version exposes the Configuration API through the public JS client, we may choose to set `space=cosine` server-side and drop the embed-time normalization. That is a strict-equivalence optimization, not a correctness fix; the current pipeline produces the same retrieval ranking either way.

### Windows host note (named volume vs. bind mount)

The compose file uses a Docker-managed named volume (`chroma-data`) rather than a host bind mount (`./data/chroma:/chroma/chroma`). On Windows, Docker Desktop's bind-mount filesystem translation (Windows ↔ WSL2/Hyper-V) is **10-20× slower** than the native Linux filesystem for the write-heavy pattern produced by Chroma's SQLite + HNSW index (many small writes, fsync-heavy). With a bind mount on Windows, full-dataset ingestion stretched to 5–15 minutes and individual upsert batches frequently hit the 30 s timeout. With a named volume the same workload completes in ~45 s.

Trade-off: data is no longer browseable via the host file explorer under `./data/chroma`. To inspect or back up:

```bash
docker run --rm -v hybrid-rag-podcasts_chroma-data:/data alpine \
  tar -czf - /data > chroma-backup.tar.gz
```

On Linux/macOS hosts the named-volume vs. bind-mount speed is identical, but the named-volume pattern is also the standard for Kubernetes / production Docker deployments, so this configuration is fully portable — no Windows-specific branch in the codebase.

### Measured rollout expectations (319-episode dataset, ~53 K vectors)

| Topology | Concurrency | Estimated write time |
|---|---|---|
| Local Docker | 3 | ~27 s (HNSW serializes server-side) |
| Same-host bare-metal | 3 | ~22 s |
| Different VM, same DC | 3 | ~21 s |
| Chroma Cloud | 5 | ~21 s |
| Chroma Cloud, tuned | 10 | ~14 s |

(Numbers are extrapolated from the in-batch timing budget; will be re-measured in Phase 2 evaluation.)

## Production deployment guide

See `README.md` "Production deployment" for the per-topology env-variable matrix and the pre-deployment checklist. Same checklist applies regardless of where Chroma runs:

- `CHROMA_URL` points at the right endpoint
- `CHROMA_API_KEY` set if the endpoint authenticates
- Concurrency and batch size tuned for the network latency profile
- Heartbeat reachable from the app host
- App logs `Chroma server reachable at ...` at boot

## Future work

- **1.3.f Streaming pipeline** — embed → write overlap via async iterators / generator pipeline. Documented in CLAUDE.md "Future optimizations".
- **Server-side metric scraping** — Chroma exposes Prometheus metrics; wire them to the local dashboard once monitoring is in scope (post-Phase 2).
- **Multi-tenant collection naming** — if a future deployment needs per-tenant isolation, prefix `CHROMA_COLLECTION` accordingly; the repository already reads the env value at boot.
