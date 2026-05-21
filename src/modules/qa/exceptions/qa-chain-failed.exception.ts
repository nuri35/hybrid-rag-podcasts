import { InternalServerErrorException } from '@nestjs/common';

/**
 * Thrown when the QA chain fails for an unexpected reason — i.e. not a
 * validation problem from upstream `RetrievalModule` (those pass through
 * unwrapped so the controller maps them to 4xx) and not a known
 * infrastructure exception. Wraps everything else into a clean 500.
 *
 * Mirrors the Phase 1.5 `RetrievalFailedException` correlation-ID pattern:
 * the public-facing message contains ONLY a generic phrase plus a UUID v4
 * correlation ID. The original underlying error message — which may
 * include Gemini SDK URLs, partial credentials, stack traces, or other
 * internals — is logged server-side alongside the correlation ID so
 * on-call can grep `correlation_id=<id>` and recover full detail without
 * leaking it to the HTTP response body.
 */
export class QaChainFailedException extends InternalServerErrorException {
  readonly correlationId: string;

  constructor(correlationId: string, publicMessage = 'QA chain failed') {
    super(`${publicMessage}. Reference: ${correlationId}`);
    this.name = 'QaChainFailedException';
    this.correlationId = correlationId;
  }
}
