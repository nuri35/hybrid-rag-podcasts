import { InternalServerErrorException } from '@nestjs/common';

/**
 * Thrown when retrieval fails for an unexpected reason — i.e. not a validation
 * problem and not a known downstream exception (`EmbeddingFailedException`,
 * `ChromaUnreachableException`, etc., which the service re-throws unwrapped).
 *
 * The public-facing message intentionally contains ONLY a generic phrase plus
 * a correlation ID (UUID v4). The original underlying error message — which
 * may include SDK URLs, partial credentials, stack traces, or other internals
 * — is logged server-side alongside the correlation ID so on-call can grep
 * `correlation_id=<id>` and recover full detail without leaking it to the HTTP
 * response body.
 */
export class RetrievalFailedException extends InternalServerErrorException {
  readonly correlationId: string;

  constructor(correlationId: string, publicMessage = 'Retrieval failed') {
    super(`${publicMessage}. Reference: ${correlationId}`);
    this.name = 'RetrievalFailedException';
    this.correlationId = correlationId;
  }
}
