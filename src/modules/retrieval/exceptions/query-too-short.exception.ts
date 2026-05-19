import { BadRequestException } from '@nestjs/common';

export class QueryTooShortException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'QueryTooShortException';
  }
}
