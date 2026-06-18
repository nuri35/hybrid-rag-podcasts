import { BadRequestException } from '@nestjs/common';

/**
 * The aggregation request is malformed: unknown aggregation type, a field
 * outside the keyword/numeric allow-list for that operation (e.g. avg on a
 * keyword field, group_by on a numeric field, or an excluded/empty field), or an
 * empty filter value. Maps to HTTP 400 via AllExceptionsFilter.
 */
export class InvalidMetadataQueryException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMetadataQueryException';
  }
}
