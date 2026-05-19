import { BadRequestException } from '@nestjs/common';

export class EmptyQueryException extends BadRequestException {
  constructor(message = 'Query must be a non-empty string') {
    super(message);
    this.name = 'EmptyQueryException';
  }
}
