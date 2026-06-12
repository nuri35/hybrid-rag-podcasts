import type { RetrievedChunk } from '../retrieval/retrieval.types';

/**
 * Result shape for an Elasticsearch keyword hit.
 *
 * DELIBERATELY the SAME type as the vector side's `RetrievedChunk`
 * (`{ id, document, score, metadata, chunkIndex }`). RRF fusion (4.3) merges a
 * list from each retriever and ranks the union; sharing one type means fusion
 * consumes both lists with NO adapter layer. The `id` (`chunk_id`) is the bridge
 * key — identical across Chroma and ES — so the same chunk from either side
 * collapses to one fused entry.
 *
 * One semantic difference the fusion layer must respect: `score` here is the raw
 * **BM25** score (unbounded, e.g. 12-28 in practice), whereas the vector side's
 * `score` is a cosine-equivalent in `[0, 1]`. The two scales are NOT comparable
 * by magnitude — which is exactly why fusion is **rank-based** (RRF), not
 * score-based. Never threshold or average these two scores directly.
 */
export type EsRetrievalHit = RetrievedChunk;
