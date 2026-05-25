import { Injectable, Logger } from '@nestjs/common';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { RollingTokenTotals, TokenUsage } from '../types/token-usage.types';

const CAPTURE_TTL_MS = 60_000;

/**
 * LangChain `LLMResult` shape varies by provider. We try the two common
 * surfaces in order:
 *
 *   1. `llmOutput.tokenUsage` — older normalised form, OpenAI-style
 *      (`promptTokens` / `completionTokens` / `totalTokens`).
 *   2. `generations[0].message.usage_metadata` — newer raw form used by
 *      `@langchain/google-genai` 0.2.x and Anthropic
 *      (`input_tokens` / `output_tokens` / `total_tokens`).
 *
 * Both are typed loosely as `unknown` and narrowed at access time so
 * `no-explicit-any: error` is satisfied without us pinning to a
 * specific LangChain minor version.
 */
interface LlmOutputTokenUsageShape {
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface GenerationMessageWithUsage {
  message?: {
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * Phase 1.6 Sprint Token — captures Gemini `usage_metadata` (input /
 * output / total tokens) for every chat LLM call via a LangChain
 * callback handler. Designed to be non-invasive: the existing chain
 * composition stays unchanged, the handler attaches via
 * `chain.invoke(input, { callbacks })`.
 *
 * Storage strategy:
 *   - per-call captures keyed by correlation ID, 60 s TTL (prevents
 *     leaks if the consumer never calls `consumeUsage`)
 *   - process-lifetime rolling totals for future `/metrics` work
 *
 * Failure mode: extraction returns `null` if neither known LangChain
 * surface carries usage data (e.g. provider didn't include it, SDK
 * version regression). Callers receive `null` from `consumeUsage` and
 * fall back to `unknown` log markers — telemetry must not break the
 * user flow.
 */
@Injectable()
export class TokenUsageService {
  private readonly logger = new Logger(TokenUsageService.name);
  private readonly captures = new Map<string, { usage: TokenUsage; expiresAt: number }>();

  private rollingTotalInputTokens = 0;
  private rollingTotalOutputTokens = 0;
  private rollingTotalRequests = 0;
  private readonly rollingSinceTimestamp = new Date().toISOString();

  /**
   * Builds a LangChain callback handler tied to one correlation ID.
   * Pass it via `chain.invoke(input, { callbacks: [handler] })` or
   * `chain.stream(input, { callbacks: [handler] })`.
   */
  createCallback(correlationId: string): BaseCallbackHandler {
    const recordUsage = (usage: TokenUsage): void => this.recordUsage(correlationId, usage);
    const extractUsage = (output: LLMResult): TokenUsage | null => this.extractUsage(output);
    const logger = this.logger;

    return new (class extends BaseCallbackHandler {
      name = 'TokenUsageCallback';

      handleLLMEnd(output: LLMResult): void {
        const usage = extractUsage(output);
        if (!usage) {
          logger.warn(
            `token_usage_missing correlation_id=${correlationId} reason=no_metadata_in_response`,
          );
          return;
        }
        recordUsage(usage);
      }
    })();
  }

  /**
   * Retrieves and removes the captured usage for a correlation ID.
   * Returns `null` if the callback never fired or the entry expired.
   */
  consumeUsage(correlationId: string): TokenUsage | null {
    this.pruneExpired();
    const entry = this.captures.get(correlationId);
    if (!entry) return null;
    this.captures.delete(correlationId);
    return entry.usage;
  }

  getRollingTotals(): RollingTokenTotals {
    return {
      totalInputTokens: this.rollingTotalInputTokens,
      totalOutputTokens: this.rollingTotalOutputTokens,
      totalRequests: this.rollingTotalRequests,
      sinceTimestamp: this.rollingSinceTimestamp,
    };
  }

  private recordUsage(correlationId: string, usage: TokenUsage): void {
    this.captures.set(correlationId, {
      usage,
      expiresAt: Date.now() + CAPTURE_TTL_MS,
    });

    this.rollingTotalInputTokens += usage.inputTokens;
    this.rollingTotalOutputTokens += usage.outputTokens;
    this.rollingTotalRequests += 1;
  }

  private extractUsage(output: LLMResult): TokenUsage | null {
    // Path 1: llmOutput.tokenUsage (OpenAI-style normalisation).
    const llmOutput = output.llmOutput as LlmOutputTokenUsageShape | undefined;
    if (llmOutput?.tokenUsage) {
      const t = llmOutput.tokenUsage;
      const inputTokens = t.promptTokens ?? 0;
      const outputTokens = t.completionTokens ?? 0;
      return {
        inputTokens,
        outputTokens,
        totalTokens: t.totalTokens ?? inputTokens + outputTokens,
      };
    }

    // Path 2: generations[0][0].message.usage_metadata (Gemini, Anthropic).
    const firstBatch = output.generations?.[0];
    if (firstBatch && firstBatch.length > 0) {
      const message = (firstBatch[0] as GenerationMessageWithUsage).message;
      if (message?.usage_metadata) {
        const m = message.usage_metadata;
        const inputTokens = m.input_tokens ?? 0;
        const outputTokens = m.output_tokens ?? 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: m.total_tokens ?? inputTokens + outputTokens,
        };
      }
    }

    return null;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.captures.entries()) {
      if (value.expiresAt < now) {
        this.captures.delete(key);
      }
    }
  }
}
