/**
 * Phase 1.6 Sprint Prompt-Security — Layer 3 verdict shape.
 *
 * VALID    → caller emits the answer normally.
 * REJECTED → caller throws (`OutputRejectedException` in `ask`) or
 *            yields an SSE `error` event (in `askStream`).
 *
 * `rejectionReason` is the categorised reason for log lines; the
 * user-facing exception / event message stays generic so we don't
 * give the attacker feedback about which check tripped.
 */
export enum OutputVerdict {
  VALID = 'VALID',
  REJECTED = 'REJECTED',
}

/**
 * What KIND of answer is being validated (Phase 5.4). The validator is
 * context-aware: the citation requirement is parameterized by this explicit typed
 * flag — the caller passes it, the validator never infers the path or matches on
 * strings. The universal floor (empty/leakage) applies to EVERY kind; only the
 * citation gate branches.
 *
 *   - DIRECT               → classic RAG answer (ask path). STRICT [Source N]
 *                            citation required (Phase 4 behavior + q007/q024 fix).
 *   - TOOL_QUERY_METADATA  → a computed metadata value (no passages). Citation NOT
 *                            required — a missing citation is valid, not a failure.
 *   - TOOL_SEARCH_CONTENT  → a tool-use content answer. Citation allowed but NOT
 *                            mandatory in 5.4 v1 (consistent with sources:[]); can
 *                            tighten later when passages are surfaced.
 */
export enum AnswerKind {
  DIRECT = 'DIRECT',
  TOOL_QUERY_METADATA = 'TOOL_QUERY_METADATA',
  TOOL_SEARCH_CONTENT = 'TOOL_SEARCH_CONTENT',
}

export interface OutputValidationResult {
  verdict: OutputVerdict;
  rejectionReason: string | null;
}
