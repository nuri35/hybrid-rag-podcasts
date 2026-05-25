/**
 * Canned no-information response. Returned from two paths:
 *   1. Empty retrieval fast path in QaChainService.ask() — no LLM call
 *   2. LLM-recognized no-info case — produced by the prompt template
 *      instruction (constant is INTERPOLATED into the template so the
 *      two paths can never drift)
 *
 * Phrasing was updated in Phase 1.6 Sprint Prompt-Security: the new
 * "cannot answer this question from the provided sources" wording is
 * matched by `OutputValidationService`'s VALID_NO_ANSWER_PHRASES
 * regex `/cannot answer (this question|your question)/i`, which
 * bypasses the citation-check layer when the LLM correctly refuses
 * due to insufficient sources. Changing the wording requires
 * updating both the template (interpolated) and the regex.
 */
export const NO_INFO_ANSWER = 'I cannot answer this question from the provided sources.' as const;
