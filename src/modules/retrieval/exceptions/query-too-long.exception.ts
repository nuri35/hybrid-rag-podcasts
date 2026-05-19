import { BadRequestException } from '@nestjs/common';

export class QueryTooLongException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'QueryTooLongException';
  }
}
