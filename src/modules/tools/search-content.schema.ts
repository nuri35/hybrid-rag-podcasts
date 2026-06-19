import { z } from 'zod';
import { SEARCH_CONTENT_DEFAULT_TOP_K, SEARCH_CONTENT_MAX_TOP_K } from './tools.constants';

/**
 * LLM-facing input schema for `search_content` (Phase 5.2.1).
 *
 * Zod is the single source of truth for the tool's arguments: it validates input
 * at runtime now AND becomes the function-calling schema bound to Gemini in 5.3.
 * `top_k` is left as a loose positive int here (described, not `.max`-rejected) —
 * the service CLAMPS it to [1, SEARCH_CONTENT_MAX_TOP_K] so an over-eager model
 * call degrades gracefully instead of erroring the whole turn.
 */
export const searchContentInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query must be a non-empty string')
    .describe('The topic or question to search the podcast transcripts for.'),
  top_k: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Number of passages to retrieve. Default ${SEARCH_CONTENT_DEFAULT_TOP_K}, ` +
        `maximum ${SEARCH_CONTENT_MAX_TOP_K} (values above are clamped).`,
    ),
});

export type SearchContentInput = z.infer<typeof searchContentInputSchema>;
