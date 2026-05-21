import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AskQuestionDto {
  @ApiProperty({
    description:
      'The natural-language question to answer. The question is embedded using ' +
      'Gemini text-embedding-001 with RETRIEVAL_QUERY task type and matched against ' +
      '~53,000 transcript chunks from Lex Fridman Podcast episodes. Whitespace is ' +
      'trimmed server-side; whitespace-only questions are rejected.',
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
      'Higher values give the LLM more context (better recall) at the cost of ' +
      'larger prompts and slower responses. Defaults to 5 when omitted.',
    example: 5,
    required: false,
    minimum: 1,
    maximum: 50,
    default: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;
}
