/**
 * Canned no-information response. Returned from two paths:
 *   1. Empty retrieval fast path in QaChainService.ask() — no LLM call
 *   2. LLM-recognized no-info case — produced by the prompt template
 *      instruction
 *
 * Both paths return the EXACT same string so callers see a consistent
 * response regardless of which branch fired. Edit both prompt template
 * and any consumer logic when changing this.
 */
export const NO_INFO_ANSWER =
  "I don't have enough information to answer this question." as const;
