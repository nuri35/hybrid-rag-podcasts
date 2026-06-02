import type { QaSource } from '../qa.types';

/**
 * Cached LLM response for the non-streaming QA endpoint (Phase 1.7.5
 * Sprint Cache). Stored as a JSON blob in Redis; sufficient to
 * reconstruct the full `QaResult` (answer + sources) without re-running
 * the LLM. `chunksCount` and `cachedAt` are operator/diagnostic fields,
 * not returned to the HTTP client.
 *
 * `sources` is the project's real `QaSource[]` shape (the spec's
 * `SourceDto` does not exist in this codebase — `QaResult.sources` is
 * `QaSource[]`).
 */
export interface CachedResponse {
  answer: string;
  sources: QaSource[];
  chunksCount: number;
  cachedAt: string;
}

/**
 * Pure inputs to `QaResponseCacheService.buildKey`. The content hash is
 * computed from `question` + sorted `chunkIds`; the remaining fields are
 * key segments that scope a cached answer to the exact model / prompt /
 * retrieval configuration + dataset version that produced it.
 */
export interface BuildKeyInput {
  question: string;
  topK: number;
  chunkIds: string[];
  model: string;
  temperature: number;
  promptHash: string;
  ingestionTimestamp: string;
}
