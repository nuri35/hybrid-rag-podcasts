import { Injectable } from '@nestjs/common';
import type { Runnable } from '@langchain/core/runnables';
import { CircuitBreakerService } from './circuit-breaker.service';
import { RetryPolicyService } from './retry-policy.service';

/**
 * Phase 1.6 Sprint Retry — Phase 3 / 3.
 *
 * Composes RetryPolicyService (Phase 1) and CircuitBreakerService
 * (Phase 2) around a LangChain Runnable invocation. The composition
 * order matters:
 *
 *   QaChainService.invokeWithTimeout (Phase 1.6 hardening)
 *     └── circuitBreaker.execute            ← outer
 *           └── retryPolicy.execute         ← inner
 *                 └── chain.invoke(input)   ← innermost
 *
 * Circuit is outer because a tripped circuit MUST short-circuit before
 * any retries fire — otherwise an OPEN circuit would still hammer the
 * upstream `maxAttempts` times per request. Retry is inner because a
 * full retry cycle (success-after-N-tries or exhaustion) counts as a
 * single "attempt" from the circuit's perspective.
 *
 * Manual smoke tests (operator validation, not automated):
 *
 *   1. Retry on transient failure:
 *      Temporarily set `LLM_RETRY_MAX_ATTEMPTS=2` in `.env`.
 *      Force a 429 / 5xx response (e.g. set GOOGLE_API_KEY to an
 *      invalid key, then restore once a couple of failures are observed).
 *      Expect `retry_attempt ...` warning logs, then `retry_exhausted`
 *      and a `RetryExhaustedException` surface.
 *
 *   2. Circuit breaker open:
 *      Set `LLM_CIRCUIT_FAILURE_THRESHOLD=2` and
 *      `LLM_CIRCUIT_OPEN_DURATION_MS=30000` in `.env`. Set
 *      `GOOGLE_API_KEY=invalid-key` to force consistent failures.
 *        a) Run 2 queries — both fail with RetryExhausted (each one a
 *           single circuit-level failure).
 *        b) Run a 3rd query — should fail INSTANTLY with
 *           `CircuitOpenException` (`circuit_blocked state=OPEN ...`);
 *           NO Gemini call is made.
 *        c) Wait `LLM_CIRCUIT_OPEN_DURATION_MS` (default 30 s) and
 *           run another query — a single half-open probe fires. With
 *           the bad key it still fails → back to OPEN.
 *        d) Restore `GOOGLE_API_KEY` to a valid value. Wait the
 *           cool-down again, run a query — probe succeeds, circuit
 *           transitions to CLOSED, subsequent queries return 200.
 */
@Injectable()
export class ResilientLlmService {
  constructor(
    private readonly retryPolicy: RetryPolicyService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  async invokeChain<TInput, TOutput>(
    chain: Runnable<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput> {
    return this.circuitBreaker.execute(async () => {
      const retryResult = await this.retryPolicy.execute(() => chain.invoke(input));
      // Defensive guard — retryPolicy.execute either resolves with
      // `success: true` or throws (RetryExhaustedException on
      // exhaustion, original error on non-retryable). The check here
      // is a programmer-error trip wire; it should never fire in
      // practice but keeps the type contract honest because
      // `RetryResult.result` is `T | undefined`.
      if (!retryResult.success || retryResult.result === undefined) {
        // `finalError` is `unknown` in the type — `only-throw-error`
        // requires we either narrow to Error or wrap.
        throw retryResult.finalError instanceof Error
          ? retryResult.finalError
          : new Error('Retry policy returned no result');
      }
      return retryResult.result;
    });
  }
}
