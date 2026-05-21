import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { QaChainService } from './qa-chain.service';
import { AskQuestionDto } from './dto/ask-question.dto';
import { QaResponseDto } from './dto/qa-response.dto';
import { ValidationErrorResponseDto } from './dto/validation-error.dto';

@ApiTags('questions')
@Controller({ path: 'questions', version: '1' })
export class QaController {
  constructor(private readonly qaChainService: QaChainService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask a question',
    description:
      'Submit a question and receive an answer based on retrieved podcast transcripts. Returns the answer along with the source chunks used for context.',
  })
  @ApiBody({
    type: AskQuestionDto,
    examples: {
      philosophy: {
        summary: 'Philosophy question (default topK)',
        description: 'Simple philosophical query, uses default topK=5.',
        value: {
          question: 'What is consciousness?',
        },
      },
      techQuestion: {
        summary: 'Tech question with custom topK',
        description: 'Narrower topK for a focused factoid question.',
        value: {
          question: 'What is AGI?',
          topK: 3,
        },
      },
      multiPerspective: {
        summary: 'Multi-perspective synthesis',
        description:
          'Open-ended question that benefits from cross-episode synthesis. Uses default topK.',
        value: {
          question: 'What do guests think about free will?',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Answer with source citations',
    type: QaResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (request body invalid or contains unknown fields)',
    type: ValidationErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Internal error (LLM failure, Chroma unreachable, etc.)',
  })
  async ask(@Body() dto: AskQuestionDto): Promise<QaResponseDto> {
    return this.qaChainService.ask(dto.question, { topK: dto.topK });
  }
}
