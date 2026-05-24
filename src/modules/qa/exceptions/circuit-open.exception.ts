import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown by CircuitBreakerService.execute when the circuit is OPEN
 * (failure threshold exceeded within the rolling window) or when a
 * HALF_OPEN probe is already in flight and a concurrent caller arrives.
 *
 * Maps to 503 with a `retryAfterSeconds` hint so the client knows when
 * the cool-down expires and another probe will be allowed. Mirrors the
 * Phase 1.7.5 Sprint A `IngestionInProgressException` envelope so the
 * frontend can handle both transient unavailability cases uniformly.
 */
export class CircuitOpenException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: `LLM service is temporarily unavailable. Retry in approximately ${retryAfterSeconds} seconds.`,
        error: 'Service Unavailable',
        retryAfterSeconds,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'CircuitOpenException';
  }
}
