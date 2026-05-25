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

export interface OutputValidationResult {
  verdict: OutputVerdict;
  rejectionReason: string | null;
}
