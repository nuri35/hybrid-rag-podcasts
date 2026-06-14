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
  /**
   * Observability hook (Phase 4 eval methodology, 2026-06-14). If provided, the
   * retriever invokes it ONCE with its final RANKED list BEFORE any
   * context-completion neighbor expansion. Pure side-channel — it does NOT
   * affect what `retrieve()` returns or what the LLM sees. The hybrid retriever
   * reports the RRF-fused top-K (pre-expansion); a retriever without expansion
   * (vector-only) reports its returned ranked list (they are identical there).
   *
   * Rank-based retrieval metrics (MRR/Hit@K/Precision@K) must be measured over
   * THIS list, not the expanded context, because expansion prepends ±1 neighbors
   * (score 0) adjacent to their parent, pushing a ground-truth chunk down a rank.
   */
  captureFusedTopK?: (fusedTopK: RetrievedChunk[]) => void;
}

/**
 * Retrieval contract — implemented by VectorRetrieverService in Phase 1.5 and
 * the future HybridRetrieverService in Phase 4. Both will be substitutable at
 * the QaChain composition layer (Liskov).
 */
export interface IRetriever {
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievedChunk[]>;
}
