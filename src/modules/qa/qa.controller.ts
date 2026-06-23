import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Observable } from 'rxjs';
import { AskQuestionDto } from './dto/ask-question.dto';
import { AskQuestionStreamQuery } from './dto/ask-question-stream.query';
import { AnswerResponseDto } from './dto/answer-response.dto';
import { ValidationErrorResponseDto } from './dto/validation-error.dto';
import { QaChainService } from './qa-chain.service';
import { QaFacadeService } from './qa-facade.service';

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

@ApiTags('questions')
@Controller({ path: 'questions', version: '1' })
export class QaController {
  // Non-streaming endpoint → QaFacadeService (picks direct vs tool-use per
  // TOOL_USE_ENABLED). Streaming endpoint → QaChainService.askStream directly
  // (Phase 4 streaming is never routed).
  constructor(
    private readonly qaFacadeService: QaFacadeService,
    private readonly qaChainService: QaChainService,
  ) {}

  // Scope to the `default` throttler (30/min). Both named throttlers apply to
  // every route by default; skipping `stream` here stops the stricter 5/min
  // stream limit from also binding this endpoint.
  @SkipThrottle({ stream: true })
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
    description:
      'Answer with source citations. `path` indicates which pipeline answered ' +
      "('direct' RAG or 'tool_use' routing). `sources` is empty on the tool-use path.",
    type: AnswerResponseDto,
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
  async ask(@Body() dto: AskQuestionDto): Promise<AnswerResponseDto> {
    return this.qaFacadeService.answer(dto.question, { topK: dto.topK });
  }

  /**
   * Phase 1.6 Sprint Streaming — SSE endpoint.
   *
   * GET (not POST) — the `@Sse()` decorator forces GET regardless of
   * method-level HTTP decorators because the browser `EventSource`
   * API only supports GET. Inputs travel as query parameters
   * (`?question=...&topK=...`) rather than a JSON body. The Phase 1.6
   * Sprint Streaming initial implementation used `@Body()` against the
   * forced-GET route — the body was always undefined and the DTO
   * always failed validation. Fixed here.
   *
   * Streams answer tokens as Server-Sent Events. Wire format follows
   * standard SSE: each event is `data: <JSON>\n\n`. JSON shapes are
   * documented in `dto/stream-event.types.ts`. Event ordering:
   *
   *   1. exactly one `{type:"sources",data:[...]}`
   *   2. zero or more `{type:"token",data:"..."}`
   *   3. exactly one terminator — `{type:"done",data:{totalChunks}}`
   *      OR `{type:"error",data:{code,message}}`
   *
   * Heartbeats (`{type:"heartbeat"}`) interleave every 15 s if no
   * payload event arrives. They prevent proxy idle-timeout closures
   * without using SSE comment lines (`:heartbeat`) which some clients
   * and intermediaries mishandle. Clients should treat the `heartbeat`
   * type as a no-op.
   *
   * Example (curl):
   *   curl -N "http://localhost:3000/api/v1/questions/stream?question=What%20is%20consciousness"
   */
  // Scope to the `stream` throttler (5/min, stricter — SSE connections are
  // long-lived and heavier). Skip `default` so this endpoint's own quota is
  // independent of the question endpoint's.
  @SkipThrottle({ default: true })
  @Sse('stream')
  @ApiOperation({
    summary: 'Ask a question (streaming, GET)',
    description:
      'GET endpoint that streams the answer back token-by-token as Server-Sent ' +
      'Events. Inputs are query parameters (the SSE/EventSource standard requires ' +
      'GET; a body cannot be carried). Events arrive in order: sources (cited ' +
      'chunks) → tokens → done. Mid-stream unrecoverable failures arrive as an ' +
      'error event with a server-side correlation ID. Heartbeat events ' +
      '(`{type:"heartbeat"}`) interleave every 15 s to keep idle proxies happy; ' +
      'clients should ignore them.',
  })
  @ApiQuery({
    name: 'question',
    required: true,
    type: String,
    description: 'Same validation rules as POST /questions (3–1000 chars).',
    example: 'What is consciousness?',
  })
  @ApiQuery({
    name: 'topK',
    required: false,
    type: Number,
    description: 'Number of top-K chunks to retrieve (1–50, default 5).',
    example: 5,
  })
  @ApiResponse({
    status: 200,
    description: 'SSE stream of answer events (sources / token / done / error / heartbeat)',
    content: {
      'text/event-stream': {
        example:
          'data: {"type":"sources","data":[{"chunkId":"14_chunk_5","score":0.92,"excerpt":"...","metadata":{...}}]}\n\n' +
          'data: {"type":"token","data":"Consciousness"}\n\n' +
          'data: {"type":"token","data":" is fundamentally"}\n\n' +
          'data: {"type":"done","data":{"totalChunks":5}}\n\n',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (same rules as the non-streaming endpoint)',
    type: ValidationErrorResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'Service unavailable — ingestion in progress, integrity mismatch, or LLM circuit open',
  })
  askStream(@Query() query: AskQuestionStreamQuery): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      // Heartbeat keeps the connection alive through proxies even when
      // the LLM is silent for >15 s (e.g., long context build, slow
      // first token). interval(...) from rxjs is unbounded by default,
      // so we own its lifecycle here via clearInterval in finally /
      // teardown — merging an unbounded interval$ into the events$
      // stream would leak the timer after events complete.
      const heartbeat = setInterval(() => {
        if (!subscriber.closed) {
          subscriber.next({
            data: JSON.stringify({ type: 'heartbeat' }),
          });
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      const generator = this.qaChainService.askStream(query.question, { topK: query.topK });

      void (async () => {
        try {
          for await (const event of generator) {
            if (subscriber.closed) return; // client disconnected
            subscriber.next({ data: JSON.stringify(event) });
          }
          subscriber.complete();
        } catch (error) {
          // `askStream` converts unknown mid-stream errors to SSE
          // `error` events INSIDE the generator. Anything thrown here
          // is a pass-through known exception (lock guard / integrity
          // gate / retrieval validation / Sprint Retry exceptions).
          // Surface via subscriber.error so NestJS maps the HTTP
          // status when it can (pre-yield throws can still set
          // headers; mid-stream throws close the connection).
          subscriber.error(error);
        } finally {
          clearInterval(heartbeat);
        }
      })();

      // Teardown — fires on client disconnect, subscriber.complete(),
      // or subscriber.error(). `generator.return()` makes a pending
      // `for await` exit cleanly so a client that drops mid-stream
      // doesn't leave the iteration hanging in the event loop.
      return () => {
        clearInterval(heartbeat);
        void generator.return();
      };
    });
  }
}
