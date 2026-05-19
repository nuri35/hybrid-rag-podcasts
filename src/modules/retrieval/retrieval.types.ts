/**
 * A chunk returned from the vector store, scored and shaped for the QA layer.
 *
 * `score` is a cosine-similarity-equivalent in `[0, 1]` — see ADR 0006
 * decision 9. Higher is more similar.
 */
export interface RetrievedChunk {
  id: string;
  document: string;
  score: number;
  metadata: Record<string, unknown>;
  chunkIndex: number;
}

/**
 * Per-call retrieval knobs. All optional; defaults come from env via
 * VectorRetrieverService.
 */
export interface RetrievalOptions {
  topK?: number;
  scoreThreshold?: number;
  filter?: Record<string, unknown>;
}

/**
 * Retrieval contract — implemented by VectorRetrieverService in Phase 1.5 and
 * the future HybridRetrieverService in Phase 4. Both will be substitutable at
 * the QaChain composition layer (Liskov).
 */
export interface IRetriever {
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievedChunk[]>;
}
