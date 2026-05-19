import { InternalServerErrorException } from '@nestjs/common';

/**
 * Thrown when the QA chain fails for an unexpected reason — i.e. not a
 * validation problem from upstream `RetrievalModule` (those pass through
 * unwrapped so the controller maps them to 4xx) and not a known
 * infrastructure exception. Wraps everything else into a clean 500.
 */
export class QaChainFailedException extends InternalServerErrorException {
  constructor(message = 'QA chain failed') {
    super(message);
    this.name = 'QaChainFailedException';
  }
}
