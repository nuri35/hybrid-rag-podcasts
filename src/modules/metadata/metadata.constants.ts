/**
 * Constants for the metadata-aggregation layer (Phase 5.1).
 *
 * Aggregations run against the EPISODE-grained `podcast_episodes` index (one doc
 * per episode), NOT the chunk-grained `podcast_chunks` index — so `doc_count`
 * equals an episode count and group_by / count / avg are structurally correct.
 * See PHASE_5_1_PLAN.md for the grain rationale.
 */

/** Episode-grained aggregation index, built by scripts/elasticsearch/build-episode-index.py. */
export const METADATA_INDEX = 'podcast_episodes';

/**
 * Closed allow-list of KEYWORD fields — the only fields that may be counted,
 * filtered, distinct-counted, or grouped on. `date`, `guest_affiliation`,
 * `guest_role` are deliberately EXCLUDED: they are empty across all docs in the
 * current dataset (verified 2026-06-18), so aggregating them would be misleading.
 */
export const KEYWORD_FIELDS = ['episode_id', 'guest_name', 'title'] as const;

/**
 * Closed allow-list of NUMERIC fields for min/max/avg. `total_chunks` is stored
 * on the episode index but intentionally NOT aggregatable — it is an internal
 * chunking artifact, not a user-facing metric (Phase 5.1 decision).
 */
export const NUMERIC_FIELDS = ['duration_min'] as const;

export const KEYWORD_FIELD_SET: ReadonlySet<string> = new Set(KEYWORD_FIELDS);
export const NUMERIC_FIELD_SET: ReadonlySet<string> = new Set(NUMERIC_FIELDS);

/** filter() episode-list caps — protect response size from a broad match. */
export const DEFAULT_FILTER_LIMIT = 50;
export const MAX_FILTER_LIMIT = 200;

/** group_by bucket caps. */
export const DEFAULT_GROUP_BY_SIZE = 10;
export const MAX_GROUP_BY_SIZE = 100;

/**
 * Per-aggregation request timeout. A metadata aggregation over 319 episode docs
 * is sub-10 ms; 5 s converts a stalled cluster into a fast fail-loud error
 * (MetadataQueryFailedException) rather than a hung request.
 */
export const METADATA_QUERY_TIMEOUT_MS = 5000;
