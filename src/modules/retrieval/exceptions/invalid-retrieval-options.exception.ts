import { BadRequestException } from '@nestjs/common';

export class InvalidRetrievalOptionsException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRetrievalOptionsException';
  }
}
