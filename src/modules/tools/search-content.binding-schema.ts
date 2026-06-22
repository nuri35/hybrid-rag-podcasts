import { z } from 'zod';
import { SEARCH_CONTENT_DEFAULT_TOP_K, SEARCH_CONTENT_MAX_TOP_K } from './tools.constants';

/**
 * Gemini-facing **binding-safe** schema for `search_content` (Phase 5.3.1).
 *
 * This is the schema bound to the model via `bindTools` — NOT the runtime trust
 * boundary. It is deliberately a relaxed mirror of the strict
 * `searchContentInputSchema`: `top_k` is a plain `z.number()` WITHOUT
 * `.int()/.positive()`, because those emit JSON-Schema `exclusiveMinimum`, which
 * Gemini's `FunctionDeclaration.parameters` (a restricted OpenAPI subset) rejects
 * with a 400 (verified end-to-end in 5.3 Step-0). `query` is a plain `z.string()`
 * (no `.min`/`.trim`, which would emit `minLength`/transforms) — the model is
 * guided by the description instead.
 *
 * The strict `searchContentInputSchema` is UNCHANGED and still runs inside
 * `SearchContentToolService.execute()` (it re-validates + clamps every arg the
 * model produces), so dropping the constraints here weakens nothing — it only
 * keeps the function-calling parameter schema within Gemini's accepted subset.
 */
export const searchContentBindingSchema = z.object({
  query: z.string().describe('The topic or question to search the podcast transcripts for.'),
  top_k: z
    .number()
    .optional()
    .describe(
      `Number of passages to retrieve. Default ${SEARCH_CONTENT_DEFAULT_TOP_K}, ` +
        `maximum ${SEARCH_CONTENT_MAX_TOP_K} (values above are clamped).`,
    ),
});

export type SearchContentBindingInput = z.infer<typeof searchContentBindingSchema>;
