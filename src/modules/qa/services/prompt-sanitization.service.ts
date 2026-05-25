import { Injectable, Logger } from '@nestjs/common';
import {
  HARD_REJECT_PATTERNS,
  MAX_QUESTION_LENGTH,
  SOFT_FLAG_PATTERNS,
  UNICODE_STRIP_RANGES,
} from './prompt-sanitization.constants';
import { SanitizationVerdict, type SanitizationResult } from '../types/sanitization.types';

/**
 * Phase 1.6 Sprint Prompt-Security — Layer 1 input sanitizer.
 *
 * Inspects raw user questions in three sequential checks:
 *
 *   1. Unicode strip — silently remove zero-width / bidi / BOM /
 *      ASCII-control characters that let an attacker hide payloads
 *      in what looks like benign text. Pure cosmetic in the failure
 *      case; the sanitised string is what flows downstream.
 *
 *   2. Length cap — reject anything over `MAX_QUESTION_LENGTH`
 *      characters after the strip. The DTO has its own
 *      `@MaxLength(1000)` for HTTP-layer validation; this is the
 *      defence-in-depth check for service-layer callers (CLI smoke
 *      tests, future evaluation harness) that may bypass the DTO.
 *
 *   3. Pattern match — hard reject (400) for high-confidence
 *      injection signals; soft flag (proceed + warn log) for
 *      medium-confidence ones. Layers 2 (prompt hardening) and 3
 *      (output validation) are the rest of the defence; this layer
 *      is just the obvious-attempt filter.
 *
 * All rejections log at WARN with the correlation ID and the matched
 * pattern IDs so operators can audit attack attempts. The PUBLIC
 * exception message (via `QuestionRejectedException`) is generic —
 * specific reasons stay server-side.
 */
@Injectable()
export class PromptSanitizationService {
  private readonly logger = new Logger(PromptSanitizationService.name);

  inspect(rawQuestion: string, correlationId: string): SanitizationResult {
    // 1. Strip Unicode tricks silently.
    let cleaned = rawQuestion;
    for (const range of UNICODE_STRIP_RANGES) {
      cleaned = cleaned.replace(range, '');
    }
    cleaned = cleaned.trim();

    // 2. Length check (post-strip — stripping can only shrink).
    if (cleaned.length > MAX_QUESTION_LENGTH) {
      this.logger.warn(
        `prompt_sanitization_rejected correlation_id=${correlationId} ` +
          `reason=length_exceeded length=${cleaned.length} max=${MAX_QUESTION_LENGTH}`,
      );
      return {
        verdict: SanitizationVerdict.REJECTED,
        sanitizedQuestion: cleaned,
        detectedPatterns: ['length_exceeded'],
        rejectionReason: 'length_exceeded',
      };
    }

    // 3a. Hard reject patterns.
    const hardMatches: string[] = [];
    for (const { id, regex } of HARD_REJECT_PATTERNS) {
      if (regex.test(cleaned)) {
        hardMatches.push(id);
      }
    }

    if (hardMatches.length > 0) {
      this.logger.warn(
        `prompt_sanitization_rejected correlation_id=${correlationId} ` +
          `reason=hard_pattern patterns=${hardMatches.join(',')}`,
      );
      return {
        verdict: SanitizationVerdict.REJECTED,
        sanitizedQuestion: cleaned,
        detectedPatterns: hardMatches,
        rejectionReason: 'hard_pattern_match',
      };
    }

    // 3b. Soft flag patterns — proceed but log.
    const softMatches: string[] = [];
    for (const { id, regex } of SOFT_FLAG_PATTERNS) {
      if (regex.test(cleaned)) {
        softMatches.push(id);
      }
    }

    if (softMatches.length > 0) {
      this.logger.warn(
        `prompt_sanitization_flagged correlation_id=${correlationId} ` +
          `patterns=${softMatches.join(',')}`,
      );
      return {
        verdict: SanitizationVerdict.FLAGGED,
        sanitizedQuestion: cleaned,
        detectedPatterns: softMatches,
        rejectionReason: null,
      };
    }

    return {
      verdict: SanitizationVerdict.ALLOWED,
      sanitizedQuestion: cleaned,
      detectedPatterns: [],
      rejectionReason: null,
    };
  }
}
