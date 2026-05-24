/**
 * Thrown by RetryPolicyService.execute when every retry attempt has
 * failed. Plain Error — wired into ResilientLlmService in Phase 3, where
 * the catch ladder decides whether to surface as QaChainFailedException
 * (correlation-ID-wrapped 500) or pass through.
 */
export class RetryExhaustedException extends Error {
  readonly attempts: number;
  readonly totalDurationMs: number;
  readonly lastError: unknown;

  constructor(attempts: number, totalDurationMs: number, lastError: unknown) {
    const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `Retry exhausted after ${attempts} attempts (${totalDurationMs}ms total): ${lastMessage}`,
    );
    this.name = 'RetryExhaustedException';
    this.attempts = attempts;
    this.totalDurationMs = totalDurationMs;
    this.lastError = lastError;
  }
}
