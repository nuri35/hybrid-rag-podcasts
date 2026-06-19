/**
 * Constants for the LLM tool layer (Phase 5.2).
 *
 * `search_content` (5.2.1) + `query_metadata` (5.2.2). The two descriptions are
 * the routing boundary the model reads in 5.3 — they are a deliberate, sharply
 * contrasting pair: content (what was said) vs. exact facts (counts/ranges).
 */

/** Tool name surfaced to the model (Gemini function-calling identifier). */
export const SEARCH_CONTENT_TOOL_NAME = 'search_content';

/** Default number of fused passages to retrieve when `top_k` is omitted. */
export const SEARCH_CONTENT_DEFAULT_TOP_K = 5;

/**
 * Hard cap on `top_k`. The hybrid retriever does NOT cap its fused `outputTopK`
 * (it is passed straight to RRF fusion), so the tool must clamp it. 10 keeps the
 * passage/token budget bounded (≈200 tokens/chunk; with ±1 expansion the returned
 * set stays ≤ MAX_EXPANDED_CHUNKS=12).
 */
export const SEARCH_CONTENT_MAX_TOP_K = 10;

/** Final content-side description (locked 5.2.2 as the contrasting pair). */
export const SEARCH_CONTENT_DESCRIPTION =
  'Use for questions about WHAT was said or discussed in the episodes — opinions, ' +
  'explanations, arguments, topics, anything from the spoken content. Returns ' +
  "relevant passages. Examples: 'What did X say about Y?', 'How did they explain Z?'";

/** Tool name surfaced to the model for the metadata-aggregation tool (5.2.2). */
export const QUERY_METADATA_TOOL_NAME = 'query_metadata';

/**
 * Closed enum of fields the `query_metadata` tool exposes to the model. MUST stay
 * in sync with `MetadataQueryService`'s allow-lists (keyword: episode_id,
 * guest_name, title; numeric: duration_min) — a unit test guards the drift. The
 * keyword↔numeric pairing (which field is valid for which `type`) is enforced at
 * runtime by the service (fail-loud), not by this flat enum.
 */
export const QUERY_METADATA_FIELDS = ['episode_id', 'guest_name', 'title', 'duration_min'] as const;

/** Final metadata-side description (locked 5.2.2 as the contrasting pair). */
export const QUERY_METADATA_DESCRIPTION =
  'Use for EXACT factual questions about the collection — counts, distinct counts, ' +
  'ranges (min/max/average), groupings, and exact-match filters over episode metadata ' +
  '(episode, guest, title, duration). Returns precise computed values, not passages. ' +
  "Examples: 'How many episodes?', 'How many distinct guests?', 'Longest/average " +
  "episode?', 'Which guest appears most?', 'How many episodes feature guest X?'";
