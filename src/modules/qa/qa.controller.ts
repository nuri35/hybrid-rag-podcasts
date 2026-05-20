import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { QaChainService } from './qa-chain.service';
import { AskQuestionDto } from './dto/ask-question.dto';
import { QaResponseDto } from './dto/qa-response.dto';

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
  @ApiBody({ type: AskQuestionDto })
  @ApiResponse({
    status: 200,
    description: 'Answer with source citations',
    type: QaResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input (missing question, length violations, etc.)',
  })
  @ApiResponse({
    status: 500,
    description: 'Internal error (LLM failure, Chroma unreachable, etc.)',
  })
  async ask(@Body() dto: AskQuestionDto): Promise<QaResponseDto> {
    return this.qaChainService.ask(dto.question, { topK: dto.topK });
  }
}
