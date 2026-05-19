import { InternalServerErrorException } from '@nestjs/common';

/**
 * Thrown when retrieval fails for an unexpected reason — i.e. not a validation
 * problem and not a known downstream exception (`EmbeddingFailedException`,
 * `ChromaUnreachableException`, etc., which the service re-throws unwrapped).
 */
export class RetrievalFailedException extends InternalServerErrorException {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalFailedException';
  }
}
