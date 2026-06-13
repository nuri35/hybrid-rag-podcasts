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

    // Accepts the full form ("[Source 4]", "[Source 4, Source 5]",
    // "[Source 1, 3]") AND the bare bracketed-number form ("[2]", "[3, 4]",
    // "[5, 9]"). The "Source" token is OPTIONAL on every number.
    //
    // Why bare [N] is accepted (Phase 4, 2026-06-13): under the larger
    // expanded multi-source context (9-11 chunks, neighbor expansion), the LLM
    // deterministically abbreviates citations from "[Source N]" to "[N]". The
    // answers are still fully grounded and DO cite the numbered sources — only
    // the marker format differs — yet the old "Source"-mandatory regex rejected
    // them as missing_citation → HTTP 500 (q007/q024 in the 4.5 eval; confirmed
    // by a deterministic 20-run investigation). Accepting [N] is a superset of
    // the old pattern: existing "[Source N]" answers still pass. Brackets with
    // no digit ("[]", "[Source]", "[abc]") still fail — they are not citations.
    const hasCitation = /\[\s*(?:Source\s+)?\d+(?:\s*,\s*(?:Source\s+)?\d+)*\s*\]/i.test(answer);
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
