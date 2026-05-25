import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Query-string DTO for `GET /api/v1/questions/stream`.
 *
 * Mirrors `AskQuestionDto` (the POST body DTO) but with two adjustments
 * for the query-string transport:
 *
 *   1. `@Type(() => Number)` on `topK` — query params arrive as strings;
 *      class-transformer's number coercion is required even with the
 *      global `enableImplicitConversion: true` because the
 *      `@IsInt()` check runs on the post-transform value and would
 *      otherwise fail on `"5"`.
 *   2. The bounds match `AskQuestionDto` exactly so a question that
 *      validates against the non-streaming endpoint also validates
 *      against the streaming endpoint — clients shouldn't see different
 *      limits across the two surfaces.
 *
 * Returned as GET-only by `@Sse('stream')` (the SSE decorator forces
 * GET regardless of method-level decorators).
 */
export class AskQuestionStreamQuery {
  @ApiProperty({
    description:
      'The natural-language question to answer. Same validation rules as the ' +
      'POST /api/v1/questions endpoint.',
    example: 'What did Roger Penrose say about consciousness?',
    minLength: 3,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  question!: string;

  @ApiProperty({
    description:
      'Number of top-K transcript chunks to retrieve from the vector store. ' +
      'Defaults to 5 when omitted. Same range as the POST endpoint.',
    example: 5,
    required: false,
    minimum: 1,
    maximum: 50,
    default: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;
}
