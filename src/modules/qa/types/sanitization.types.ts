/**
 * Outcome of `PromptSanitizationService.inspect`. The three verdicts
 * map onto distinct caller responses:
 *
 *   - ALLOWED  → proceed with `sanitizedQuestion` unchanged in semantics
 *   - FLAGGED  → proceed with the same `sanitizedQuestion`, but the
 *                downstream pipeline knows the input matched a
 *                suspicious-but-not-high-confidence pattern (logged
 *                at warn level, no exception thrown)
 *   - REJECTED → caller throws `QuestionRejectedException` (400);
 *                `rejectionReason` is the categorised reason for logs
 *                ONLY — the user-facing message stays generic so we
 *                don't leak which patterns we detect
 */
export enum SanitizationVerdict {
  ALLOWED = 'ALLOWED',
  FLAGGED = 'FLAGGED',
  REJECTED = 'REJECTED',
}

export interface SanitizationResult {
  verdict: SanitizationVerdict;
  /** Question with Unicode tricks stripped + trimmed — returned even on rejection for logging. */
  sanitizedQuestion: string;
  /** Pattern IDs that matched (empty for ALLOWED). */
  detectedPatterns: string[];
  /** Categorised reason for REJECTED (null otherwise) — internal log field, never user-facing. */
  rejectionReason: string | null;
}
