import type { MetadataQueryResult } from '../metadata/metadata.types';

/**
 * One shaped passage returned by `search_content` (Phase 5.2.1).
 *
 * Deliberately lighter than the QA layer's `QaSource`: it drops the RRF `score`
 * (meaningless magnitude; neighbor-expanded chunks are 0), the chunk id, the
 * chunk-index/total-chunks bookkeeping, and the empty metadata fields
 * (`guest_affiliation`, `guest_role`, `date`). `guestName` is present only when
 * non-empty (attribution aid).
 */
export interface SearchContentPassage {
  text: string;
  title: string;
  episodeId: string;
  guestName?: string;
}

/**
 * Result of a `search_content` call. `passages` is the structured contract
 * (testable, order-preserved). `context` is the LLM-facing rendering — the same
 * `[Source N]` numbered-block convention `QaChainService.formatContext()` uses,
 * enriched with an attribution header — carried by the ToolMessage in 5.3.
 */
export interface SearchContentResult {
  passages: SearchContentPassage[];
  context: string;
}

/**
 * Result of a `query_metadata` call (Phase 5.2.2). Symmetric to
 * `SearchContentResult`: `result` is the structured typed aggregation output
 * (the testable contract, straight from `MetadataQueryService.aggregate()`);
 * `summary` is a one-line natural-language rendering — the LLM-facing string the
 * 5.3 ToolMessage will carry.
 */
export interface QueryMetadataResult {
  result: MetadataQueryResult;
  summary: string;
}
