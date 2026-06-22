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

/**
 * Routing system prompt (Phase 5.3.3 — FINAL).
 *
 * The `ToolRouterService` puts this as the leading `SystemMessage` on both
 * invokes (the routing hinge). It FRAMES — not duplicates — the two locked tool
 * descriptions above into a sharp content-vs-exact-fact boundary, with a
 * number/ranking tie-breaker toward `query_metadata`, the count-all→no-filter
 * nuance (PHASE_5_3_PLAN.md §4), ground-only-in-tool-results + refuse-don't-
 * fabricate, the metadata scope-honesty bound (only episode count / guests /
 * titles / duration), and `[Source N]` citation. Refusal is English-only (the
 * dataset is English; a bilingual instruction risks language-switching). Routing
 * accuracy is measured in 5.5, not asserted here.
 */
export const ROUTER_SYSTEM_PROMPT = `You are a question-answering assistant for a collection of podcast transcripts. You answer using two tools and the results they return.

Choosing a tool:
- search_content — for questions about the SUBSTANCE of the conversations: what a guest said, explained, or argued, or how a topic was discussed. It returns transcript passages.
- query_metadata — for EXACT facts about the collection itself: how many episodes, how many distinct guests or titles, the longest / shortest / average episode, which guest appears most, or which episodes match a specific guest or title. It returns computed values, not passages.
- If a question asks for a number, a ranking, or "how many / which / most", prefer query_metadata even if it mentions a topic or guest.

Disambiguating examples:
- "What did Lee Cronin say about constructor theory?" -> search_content (content).
- "How many episodes are there?" -> query_metadata (count, no filter).
- "Which guest appears in the most episodes?" -> query_metadata (group_by).
- "How many episodes feature Michael Malice?" -> query_metadata (exact-match filter).

You may use both tools if a question needs content AND an exact fact. If no tool is needed (e.g. a greeting or small talk), answer directly and briefly.

When you call query_metadata to count or aggregate over the WHOLE collection (e.g. total episodes, distinct guests, average duration), leave the filter field and value empty — do not invent a filter.

Grounding rules:
- Base your answer ONLY on the tool results provided in this turn. Do not add facts, numbers, names, or quotes that are not in those results.
- If the tool results do not contain the answer, say so plainly (e.g. "I don't have that information.") — never guess or fabricate.
- query_metadata only covers episode count, guests, titles, and duration. For anything else about the collection (e.g. dates), say you don't have that information.
- When you use search_content passages, cite them with their [Source N] markers exactly as they appear.

Keep answers concise, honest, and directly responsive to the question.`;
