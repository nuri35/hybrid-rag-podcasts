/**
 * Metadata key names used by the retrieval layer.
 *
 * These MUST match the keys written by `IngestionPipelineService` /
 * `ChunkerService` during ingestion. A mismatch (rename, casing change,
 * ingestion-side refactor) causes `mapToRetrievedChunks()` to silently fall
 * back to the array index for `chunkIndex`; a warn log fires when that
 * happens so the operational signal is preserved.
 *
 * Keeping the key strings in one place gives us:
 *   - a single source of truth (typo-safe at compile time),
 *   - a stable target for the allow-list in `sanitizeFilter()` (Sprint 4),
 *   - a discoverable export for future consumers (evaluation harness,
 *     hybrid retriever) that need to inspect chunk metadata.
 */
export const METADATA_KEYS = {
  CHUNK_INDEX: 'chunk_index',
  EPISODE_ID: 'episode_id',
  SOURCE: 'source',
} as const;

export type MetadataKey = (typeof METADATA_KEYS)[keyof typeof METADATA_KEYS];
