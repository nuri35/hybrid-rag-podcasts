/**
 * Constants for the LLM tool layer (Phase 5.2).
 *
 * 5.2.1 defines `search_content`. The final tool descriptions are locked
 * jointly with `query_metadata` in 5.2.2 so the routing boundary is sharp; the
 * description here is provisional.
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

/**
 * Provisional content-side description (final wording locked in 5.2.2 alongside
 * `query_metadata`). The boundary: `search_content` = what was *said/discussed*;
 * `query_metadata` = exact facts/counts over the collection.
 */
export const SEARCH_CONTENT_DESCRIPTION =
  'Search the podcast transcripts for passages about a topic. Use this for ' +
  'questions about what was said or discussed in the episodes — opinions, ' +
  'explanations, quotes, arguments, or any subject matter in the conversations. ' +
  'Do NOT use it for counts, lists, or exact facts about the collection ' +
  '(how many episodes, which guests, longest episode) — that is query_metadata.';
