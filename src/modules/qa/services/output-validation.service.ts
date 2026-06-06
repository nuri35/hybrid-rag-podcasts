import { Injectable, Logger } from '@nestjs/common';
import {
  MIN_ANSWER_LENGTH_FOR_CITATION_CHECK,
  SYSTEM_PROMPT_LEAKAGE_PHRASES,
  VALID_NO_ANSWER_PHRASES,
} from './output-validation.constants';
import { OutputVerdict, type OutputValidationResult } from '../types/output-validation.types';

/**
 * Phase 1.6 Sprint Prompt-Security — Layer 3 of the multi-layer
 * injection defence. Inspects the LLM-generated answer AFTER the
 * existing `cleanAnswer` post-processing and BEFORE the response
 * goes back to the client.
 *
 * Two independent gates, evaluated in order:
 *
 *   1. SYSTEM PROMPT LEAKAGE — if any distinctive phrase from our
 *      hardened template appears verbatim in the answer, the LLM
 *      has either leaked our instructions or echoed a context-
 *      poisoned reflection of them. Both are bad. Reject.
 *
 *   2. CITATION PRESENCE — substantive answers without `[Source N]`
 *      grounding fail. Two automatic bypasses:
 *        a. Answers below `MIN_ANSWER_LENGTH_FOR_CITATION_CHECK`
 *           skip the check (terse responses are fine ungrounded).
 *        b. Valid-refusal phrases (`/cannot answer/`, `/insufficient
 *           context/`, etc.) skip the check — a refusal has no
 *           citations by design.
 *
 * The streaming path applies the same logic to the accumulated
 * answer but the response shape on rejection differs (SSE `error`
 * event instead of thrown exception — tokens already shipped).
 */
@Injectable()
export class OutputValidationService {
  private readonly logger = new Logger(OutputValidationService.name);

  validate(answer: string, correlationId: string): OutputValidationResult {
    // Gate 1 — leakage.
    for (const phrase of SYSTEM_PROMPT_LEAKAGE_PHRASES) {
      if (answer.includes(phrase)) {
        this.logger.warn(
          `output_validation_rejected correlation_id=${correlationId} ` +
            `reason=prompt_leakage phrase=${phrase.substring(0, 30)}`,
        );
        return {
          verdict: OutputVerdict.REJECTED,
          rejectionReason: 'prompt_leakage',
        };
      }
    }

    // Gate 2 — citation presence. Skip for very short answers and
    // valid refusals (a "cannot answer" reply has no citations on
    // purpose).
    if (answer.length < MIN_ANSWER_LENGTH_FOR_CITATION_CHECK) {
      return { verdict: OutputVerdict.VALID, rejectionReason: null };
    }

    const hasValidRefusal = VALID_NO_ANSWER_PHRASES.some((pattern) => pattern.test(answer));
    if (hasValidRefusal) {
      return { verdict: OutputVerdict.VALID, rejectionReason: null };
    }

    // Accepts single ("[Source 4]") and multi-source brackets the LLM
    // legitimately produces ("[Source 4, Source 5]", "[Source 1, 3]").
    // The single-source-only form falsely rejected grounded answers in
    // the Phase 2 baseline run (2026-06-06, q001).
    const hasCitation = /\[Source\s+\d+(?:\s*,\s*(?:Source\s+)?\d+)*\s*\]/i.test(answer);
    if (!hasCitation) {
      this.logger.warn(
        `output_validation_rejected correlation_id=${correlationId} ` +
          `reason=missing_citation answer_length=${answer.length}`,
      );
      return {
        verdict: OutputVerdict.REJECTED,
        rejectionReason: 'missing_citation',
      };
    }

    return { verdict: OutputVerdict.VALID, rejectionReason: null };
  }
}
