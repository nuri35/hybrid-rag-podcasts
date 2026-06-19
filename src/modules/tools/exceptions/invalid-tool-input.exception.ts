import { BadRequestException } from '@nestjs/common';

/**
 * A tool was invoked with malformed arguments (e.g. an empty `search_content`
 * query). Thrown by the tool service BEFORE touching any downstream service.
 * Maps to HTTP 400 via AllExceptionsFilter. (Phase 5.2.1.)
 */
export class InvalidToolInputException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolInputException';
  }
}
