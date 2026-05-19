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
 * Result of a QA chain invocation. `sources` are the chunks that were fed
 * into the LLM context — same order as the retrieval ranking, NOT
 * re-ordered by relevance to the generated answer.
 */
export interface QaResult {
  answer: string;
  sources: QaSource[];
}

/**
 * Per-call QA knobs. `topK` controls how many chunks the retriever pulls
 * for context. Defaults come from env (`QA_DEFAULT_TOP_K`).
 */
export interface QaOptions {
  topK?: number;
}
