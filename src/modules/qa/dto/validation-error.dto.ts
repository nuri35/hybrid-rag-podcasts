import { ApiProperty } from '@nestjs/swagger';

/**
 * Documents the response body shape NestJS returns for validation failures
 * via the global ValidationPipe + AllExceptionsFilter. This is the
 * NestJS-default envelope; RFC 7807 problem-details migration is deferred
 * to Phase 1.7.5.
 */
export class ValidationErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code (always 400 for validation errors).',
    example: 400,
  })
  statusCode!: number;

  @ApiProperty({
    description:
      'List of validation messages. One entry per failed constraint. ' +
      'Message text is class-validator default text and may change between versions.',
    example: [
      'question must be longer than or equal to 3 characters',
      'topK must not be greater than 50',
    ],
    type: [String],
  })
  message!: string[];

  @ApiProperty({
    description: 'Standard NestJS error name.',
    example: 'Bad Request',
  })
  error!: string;
}
