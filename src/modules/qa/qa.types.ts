/**
 * One source citation surfaced alongside an LLM answer.
 *
 * `score` is the cosine-similarity-equivalent returned by the retriever
 * (`1 − L²/2` for unit vectors, clamped to `[0, 1]`). `excerpt` is the
 * first `QA_SOURCE_EXCERPT_LENGTH` chars of the chunk document with `...`
 * appended if truncated.
 */
export interface QaSource {
  chunkId: string;
  score: number;
  excerpt: string;
  metadata: Record<string, unknown>;
}

/**
 * One entry of the pre-expansion RRF-fused ranked list (Phase 4 eval
 * methodology). `rrfScore` is the retrieval ranking score (RRF when hybrid is
 * on; cosine when the legacy vector-only path is active). `rank` is 1-based.
 */
export interface FusedChunkRef {
  chunkId: string;
  rrfScore: number;
  rank: number;
}

/**
 * Retrieval-side metadata surfaced for evaluation. `fusedTopK` is the retrieval
 * system's final RANKED list BEFORE neighbor-chunk expansion — the correct
 * source for rank metrics (MRR/Hit@K/Precision@K). It is NOT the LLM context;
 * that remains `QaResult.sources` (the expanded list).
 */
export interface RetrievalMetadata {
  fusedTopK: FusedChunkRef[];
}

/**
 * Result of a QA chain invocation. `sources` are the chunks that were fed
 * into the LLM context — same order as the retrieval ranking, NOT
 * re-ordered by relevance to the generated answer.
 *
 * `retrievalMetadata` (optional) carries the pre-expansion fused top-K for the
 * eval harness. Omitted on cache hits (the cache does not store it) and on the
 * empty-retrieval fast path.
 */
export interface QaResult {
  answer: string;
  sources: QaSource[];
  retrievalMetadata?: RetrievalMetadata;
}

/**
 * Per-call QA knobs. `topK` controls how many chunks the retriever pulls
 * for context. Defaults come from env (`QA_DEFAULT_TOP_K`).
 */
export interface QaOptions {
  topK?: number;
}
