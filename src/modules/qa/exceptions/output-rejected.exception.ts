import { InternalServerErrorException } from '@nestjs/common';

/**
 * Thrown by `QaChainService.ask` when `OutputValidationService` rejects
 * the LLM's answer (system-prompt leakage detected, or missing
 * citation on a substantive answer).
 *
 * Maps to 500 because the failure is on OUR side — the model produced
 * something we won't surface, but the request itself was valid. The
 * public message is generic; the categorised reason lives in the
 * WARN log line under the correlation ID.
 *
 * In the streaming path (`askStream`) this exception is NOT thrown —
 * tokens have already shipped to the client. The validation outcome
 * is yielded as an SSE `error` event instead. See the streaming
 * trade-off discussion in ADR 0013.
 */
export class OutputRejectedException extends InternalServerErrorException {
  constructor() {
    super({
      statusCode: 500,
      message: 'The generated response could not be returned. Please rephrase your question.',
      error: 'Internal Server Error',
    });
    this.name = 'OutputRejectedException';
  }
}
