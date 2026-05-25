/**
 * Token-usage telemetry captured per LLM call. Field names are the
 * canonical Gemini / OpenAI / Anthropic shape; provider-specific names
 * (e.g. promptTokens / completionTokens from older OpenAI normalisation)
 * are translated to these in `TokenUsageService.extractUsage`.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Process-lifetime cumulative totals. Reset only on process restart.
 * `sinceTimestamp` is set once at service construction so a `/metrics`
 * endpoint added in a later sprint can compute rates over any window.
 */
export interface RollingTokenTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  sinceTimestamp: string;
}
