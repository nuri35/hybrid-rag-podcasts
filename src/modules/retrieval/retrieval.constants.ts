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

/**
 * Top-level keys callers are allowed to filter on. Anything else in a
 * `RetrievalOptions.filter` is rejected by `sanitizeFilter()` with
 * `InvalidRetrievalOptionsException` BEFORE the embedder is even called.
 *
 * Keep this list aligned with `METADATA_KEYS` — these are the same fields
 * ingestion writes into Chroma metadata. Adding a new key here without an
 * ingestion-side change would let callers filter on a field that does not
 * exist on any document (silently empty results).
 *
 * Top-level operator keys like `$or` and `$and` are intentionally NOT here
 * — they would let callers compose unbounded boolean queries against the
 * collection. Disjunction support, if ever needed, should be a deliberate
 * API change, not an accidental side effect of a permissive whitelist.
 */
export const ALLOWED_FILTER_KEYS: ReadonlySet<string> = new Set(Object.values(METADATA_KEYS));

/**
 * Per-field operators callers are allowed to use inside an operator object
 * (e.g. `{ episode_id: { $eq: '14' } }`). Conservative whitelist:
 *
 *   - `$eq` is redundant with the implicit-equality primitive form but kept
 *     so callers can express equality unambiguously when building filters
 *     programmatically.
 *   - `$in` covers the common "any of these episodes" case without opening
 *     up arbitrary set algebra.
 *
 * Operators like `$ne`, `$nin`, `$gt`/`$lt`/`$gte`/`$lte`, `$not` are
 * deliberately omitted — extend only with a deliberate review (cost +
 * recall + leak-via-enumeration risk all in scope).
 */
export const ALLOWED_FILTER_OPERATORS: ReadonlySet<string> = new Set(['$eq', '$in']);
