import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryExhaustedException } from '../exceptions/retry-exhausted.exception';
import type { RetryOptions, RetryResult } from '../types/retry-policy.types';
import type { Env } from '../../../common/config/env.schema';
import {
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  RETRYABLE_HTTP_STATUS_CODES,
  RETRYABLE_NODE_ERROR_CODES,
} from './retry-policy.constants';

/**
 * Loose intersection used by `extractHttpStatus` to inspect SDK errors
 * without `any` casts. Different LangChain / Gemini / fetch error shapes
 * stash the HTTP status on different properties; we probe all three and
 * accept whichever is a number.
 */
interface HttpStatusBearingError {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
}

/**
 * Phase 1.6 Sprint Retry — Phase 1.
 *
 * Standalone retry primitive with exponential backoff + jitter and
 * deterministic retryable / non-retryable classification. NOT wired into
 * QaChainService here — that's Phase 3 (ResilientLlmService wraps the
 * chat LLM and uses this primitive). Embedder retries stay separate
 * (Phase 1.3 has its own token-bucket + adaptive-retry path).
 *
 * Classification (synchronous, no I/O):
 *   - Retryable: HTTP 429 / 5xx (per `RETRYABLE_HTTP_STATUS_CODES`),
 *     Node network errors (ETIMEDOUT / ECONNRESET / ECONNREFUSED /
 *     EAI_AGAIN / ENOTFOUND), or message patterns like /rate.?limit/i,
 *     /timeout/i.
 *   - Not retryable: 4xx (except 429), auth failures, validation errors
 *     thrown by our own code, anything we can't positively identify.
 *
 * Backoff: starts at `LLM_RETRY_INITIAL_DELAY_MS`, multiplies by
 * `LLM_RETRY_BACKOFF_FACTOR` each step, capped at `LLM_RETRY_MAX_DELAY_MS`.
 * Jitter applies ±`LLM_RETRY_JITTER_FACTOR` to each delay so concurrent
 * callers don't thunder-herd a recovering backend.
 */
@Injectable()
export class RetryPolicyService {
  private readonly logger = new Logger(RetryPolicyService.name);
  private readonly defaultOptions: RetryOptions;

  constructor(configService: ConfigService<Env, true>) {
    this.defaultOptions = {
      maxAttempts: configService.get('LLM_RETRY_MAX_ATTEMPTS', { infer: true }),
      initialDelayMs: configService.get('LLM_RETRY_INITIAL_DELAY_MS', { infer: true }),
      maxDelayMs: configService.get('LLM_RETRY_MAX_DELAY_MS', { infer: true }),
      backoffFactor: configService.get('LLM_RETRY_BACKOFF_FACTOR', { infer: true }),
      jitterFactor: configService.get('LLM_RETRY_JITTER_FACTOR', { infer: true }),
    };
  }

  isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    // 1. Node network errors expose a `.code` string.
    const nodeCode = (error as NodeJS.ErrnoException).code;
    if (typeof nodeCode === 'string' && RETRYABLE_NODE_ERROR_CODES.has(nodeCode)) {
      return true;
    }

    // 2. HTTP status — present on most SDK error shapes.
    const httpStatus = this.extractHttpStatus(error);
    if (httpStatus !== null) {
      return RETRYABLE_HTTP_STATUS_CODES.has(httpStatus);
    }

    // 3. Last resort: message pattern. Only fires when no structured
    //    information was available — keeps the classifier robust against
    //    SDKs that wrap errors without preserving status/code.
    return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(error.message));
  }

  async execute<T>(
    operation: () => Promise<T>,
    options?: Partial<RetryOptions>,
  ): Promise<RetryResult<T>> {
    const config: RetryOptions = { ...this.defaultOptions, ...options };
    const startTime = Date.now();
    let attempt = 0;
    let lastError: unknown;
    let currentDelay = config.initialDelayMs;

    while (attempt < config.maxAttempts) {
      attempt++;
      try {
        const result = await operation();
        return {
          success: true,
          result,
          attempts: attempt,
          totalDurationMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error;
        const errorClass = error instanceof Error ? error.constructor.name : 'Unknown';
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (!this.isRetryable(error)) {
          this.logger.warn(
            `retry_skipped attempt=${attempt} reason=non_retryable ` +
              `error_class=${errorClass} error_message=${errorMessage}`,
          );
          throw error;
        }

        if (attempt >= config.maxAttempts) {
          this.logger.error(
            `retry_exhausted attempts=${attempt} total_ms=${Date.now() - startTime} ` +
              `error_class=${errorClass} error_message=${errorMessage}`,
          );
          throw new RetryExhaustedException(attempt, Date.now() - startTime, error);
        }

        const jitteredDelay = this.applyJitter(currentDelay, config.jitterFactor);
        this.logger.warn(
          `retry_attempt attempt=${attempt}/${config.maxAttempts} ` +
            `delay_ms=${jitteredDelay} error_class=${errorClass}`,
        );
        await this.sleep(jitteredDelay);
        currentDelay = Math.min(currentDelay * config.backoffFactor, config.maxDelayMs);
      }
    }

    // Unreachable in practice — the loop above either returns success or
    // throws on the final attempt. Defensive throw kept so the signature
    // is honest (`Promise<RetryResult<T>>` always resolves to a `success`
    // result; failure paths throw).
    throw new RetryExhaustedException(attempt, Date.now() - startTime, lastError);
  }

  private extractHttpStatus(error: Error): number | null {
    const e = error as Error & HttpStatusBearingError;
    const candidate = e.status ?? e.statusCode ?? e.response?.status;
    return typeof candidate === 'number' ? candidate : null;
  }

  private applyJitter(delayMs: number, factor: number): number {
    const jitterRange = delayMs * factor;
    const offset = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(0, Math.round(delayMs + offset));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
