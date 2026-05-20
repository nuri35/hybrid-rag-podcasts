import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsInt, IsOptional, Min, Max, MinLength, MaxLength } from 'class-validator';

export class AskQuestionDto {
  @ApiProperty({
    description: 'The question to ask about podcast content',
    example: 'What is consciousness?',
    minLength: 3,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  question!: string;

  @ApiProperty({
    description: 'Number of relevant context chunks to retrieve',
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
