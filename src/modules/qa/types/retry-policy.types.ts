export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterFactor: number;
}

export interface RetryAttemptInfo {
  attemptNumber: number;
  delayMs: number;
  errorClass: string;
  errorMessage: string;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  attempts: number;
  totalDurationMs: number;
  finalError?: unknown;
}
