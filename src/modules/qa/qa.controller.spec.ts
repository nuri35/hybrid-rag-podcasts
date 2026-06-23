import type { MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Observable } from 'rxjs';
import { ChromaUnreachableException } from '../vector-store/exceptions';
import { RetrievalFailedException } from '../retrieval/exceptions';
import { AskQuestionDto } from './dto/ask-question.dto';
import { AskQuestionStreamQuery } from './dto/ask-question-stream.query';
import { CircuitOpenException } from './exceptions/circuit-open.exception';
import { QaChainFailedException } from './exceptions';
import { QaChainService } from './qa-chain.service';
import { QaFacadeService } from './qa-facade.service';
import { QaController } from './qa.controller';
import type { AnswerResponseDto } from './dto/answer-response.dto';
import type { StreamEvent } from './dto/stream-event.types';

interface MockQaChainService {
  askStream: jest.Mock<
    AsyncGenerator<StreamEvent, void, void>,
    [string, { topK?: number } | undefined]
  >;
}

interface MockQaFacadeService {
  answer: jest.Mock<Promise<AnswerResponseDto>, [string, { topK?: number } | undefined]>;
}

function makeMockQaChainService(): MockQaChainService {
  return {
    // Default askStream produces no events. Sprint Streaming tests
    // override per-test to drive specific sequences.
    askStream: jest.fn<
      AsyncGenerator<StreamEvent, void, void>,
      [string, { topK?: number } | undefined]
      // eslint-disable-next-line require-yield
    >(async function* () {
      await Promise.resolve();
    }),
  };
}

function makeMockQaFacadeService(): MockQaFacadeService {
  return {
    answer: jest.fn<Promise<AnswerResponseDto>, [string, { topK?: number } | undefined]>(),
  };
}

/** Subscribe to the controller's Observable and collect all MessageEvents until complete/error. */
async function collectObservable(
  observable: Observable<MessageEvent>,
): Promise<{ events: MessageEvent[]; error: unknown }> {
  return new Promise((resolve) => {
    const events: MessageEvent[] = [];
    observable.subscribe({
      next: (e) => events.push(e),
      complete: () => resolve({ events, error: undefined }),
      error: (error: unknown) => resolve({ events, error }),
    });
  });
}

async function buildController(
  qaChainService: MockQaChainService = makeMockQaChainService(),
  qaFacadeService: MockQaFacadeService = makeMockQaFacadeService(),
): Promise<{
  controller: QaController;
  qaChainService: MockQaChainService;
  qaFacadeService: MockQaFacadeService;
}> {
  const moduleRef = await Test.createTestingModule({
    controllers: [QaController],
    providers: [
      { provide: QaChainService, useValue: qaChainService },
      { provide: QaFacadeService, useValue: qaFacadeService },
    ],
  }).compile();

  return {
    controller: moduleRef.get(QaController),
    qaChainService,
    qaFacadeService,
  };
}

function makeDto(question: string, topK?: number): AskQuestionDto {
  const dto = new AskQuestionDto();
  dto.question = question;
  if (topK !== undefined) dto.topK = topK;
  return dto;
}

/**
 * Streaming endpoint takes its input from query-string parameters
 * (`?question=...&topK=...`) — `@Sse()` forces the route to GET, so a
 * body is impossible. Tests for `askStream` use this factory to
 * construct the AskQuestionStreamQuery the controller would receive
 * after ValidationPipe materialisation.
 */
function makeStreamQuery(question: string, topK?: number): AskQuestionStreamQuery {
  const query = new AskQuestionStreamQuery();
  query.question = question;
  if (topK !== undefined) query.topK = topK;
  return query;
}

describe('QaController', () => {
  it('delegates to QaFacadeService.answer() with question + topK from DTO', async () => {
    const expected: AnswerResponseDto = {
      answer: 'mock answer',
      sources: [
        {
          chunkId: 'ep_001_chunk_0',
          score: 0.91,
          excerpt: 'chunk excerpt',
          metadata: { episode_id: 'ep_001' },
        },
      ],
      path: 'direct',
    };
    const qaFacadeService = makeMockQaFacadeService();
    qaFacadeService.answer.mockResolvedValue(expected);

    const { controller } = await buildController(makeMockQaChainService(), qaFacadeService);
    const result = await controller.ask(makeDto('What is consciousness?', 3));

    expect(qaFacadeService.answer).toHaveBeenCalledTimes(1);
    expect(qaFacadeService.answer).toHaveBeenCalledWith('What is consciousness?', { topK: 3 });
    expect(result).toBe(expected);
  });

  it('passes topK as undefined when DTO omits it (facade applies default)', async () => {
    const qaFacadeService = makeMockQaFacadeService();
    qaFacadeService.answer.mockResolvedValue({ answer: 'x', sources: [], path: 'direct' });

    const { controller } = await buildController(makeMockQaChainService(), qaFacadeService);
    await controller.ask(makeDto('a valid question'));

    expect(qaFacadeService.answer).toHaveBeenCalledWith('a valid question', { topK: undefined });
  });

  it('returns the facade result unchanged (e.g. tool-use path shape)', async () => {
    const toolUse: AnswerResponseDto = {
      answer: 'There are 319 episodes.',
      sources: [],
      toolUsed: ['query_metadata'],
      latency: 42,
      path: 'tool_use',
    };
    const qaFacadeService = makeMockQaFacadeService();
    qaFacadeService.answer.mockResolvedValue(toolUse);

    const { controller } = await buildController(makeMockQaChainService(), qaFacadeService);
    const result = await controller.ask(makeDto('How many episodes?'));

    expect(result).toBe(toolUse);
    expect(result.path).toBe('tool_use');
  });

  it.each([
    ['QaChainFailedException', new QaChainFailedException('00000000-0000-4000-8000-000000000002')],
    [
      'RetrievalFailedException',
      new RetrievalFailedException('00000000-0000-4000-8000-000000000001'),
    ],
    [
      'ChromaUnreachableException',
      new ChromaUnreachableException('http://localhost:8000', 'ECONNREFUSED'),
    ],
  ])('propagates %s from the facade unchanged', async (_label, error) => {
    const qaFacadeService = makeMockQaFacadeService();
    qaFacadeService.answer.mockRejectedValue(error);

    const { controller } = await buildController(makeMockQaChainService(), qaFacadeService);
    const caught = await controller.ask(makeDto('a valid question')).catch((e: unknown) => e);

    expect(caught).toBe(error);
  });

  // ----------------------------------------------------------------------
  // Phase 1.6 Sprint Streaming — POST /api/v1/questions/stream
  // ----------------------------------------------------------------------
  describe('askStream (SSE endpoint)', () => {
    it('delegates to QaChainService.askStream with question + topK from the DTO', async () => {
      const qaChainService = makeMockQaChainService();
      qaChainService.askStream.mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          await Promise.resolve();
        },
      );

      const { controller } = await buildController(qaChainService);
      await collectObservable(controller.askStream(makeStreamQuery('a valid question', 7)));

      expect(qaChainService.askStream).toHaveBeenCalledTimes(1);
      expect(qaChainService.askStream).toHaveBeenCalledWith('a valid question', { topK: 7 });
    });

    it('passes topK=undefined when DTO omits it (service applies its own default)', async () => {
      const qaChainService = makeMockQaChainService();
      qaChainService.askStream.mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          await Promise.resolve();
        },
      );

      const { controller } = await buildController(qaChainService);
      await collectObservable(controller.askStream(makeStreamQuery('a valid question')));

      expect(qaChainService.askStream).toHaveBeenCalledWith('a valid question', {
        topK: undefined,
      });
    });

    it('emits each yielded StreamEvent as a MessageEvent with JSON-stringified data, in order', async () => {
      const qaChainService = makeMockQaChainService();
      qaChainService.askStream.mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: 'sources', data: [] };
        yield { type: 'token', data: 'Hello' };
        yield { type: 'token', data: ' world' };
        yield { type: 'done', data: { totalChunks: 0 } };
      });

      const { controller } = await buildController(qaChainService);
      const { events, error } = await collectObservable(
        controller.askStream(makeStreamQuery('a valid question')),
      );

      expect(error).toBeUndefined();
      expect(events.map((e) => e.data)).toEqual([
        '{"type":"sources","data":[]}',
        '{"type":"token","data":"Hello"}',
        '{"type":"token","data":" world"}',
        '{"type":"done","data":{"totalChunks":0}}',
      ]);
    });

    it('completes the Observable when the underlying generator completes', async () => {
      const qaChainService = makeMockQaChainService();
      qaChainService.askStream.mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: 'sources', data: [] };
        yield { type: 'done', data: { totalChunks: 0 } };
      });

      const { controller } = await buildController(qaChainService);
      const { events, error } = await collectObservable(
        controller.askStream(makeStreamQuery('a valid question')),
      );

      // `error: undefined` means the Promise resolved via `complete`, not via `error`.
      expect(error).toBeUndefined();
      expect(events).toHaveLength(2);
    });

    it('surfaces a thrown pass-through exception via subscriber.error (HTTP layer maps to 503)', async () => {
      const qaChainService = makeMockQaChainService();
      const circuitErr = new CircuitOpenException(30);
      qaChainService.askStream.mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          await Promise.resolve();
          throw circuitErr;
        },
      );

      const { controller } = await buildController(qaChainService);
      const { events, error } = await collectObservable(
        controller.askStream(makeStreamQuery('a valid question')),
      );

      expect(events).toEqual([]);
      expect(error).toBe(circuitErr);
      expect(error).toBeInstanceOf(CircuitOpenException);
    });

    it('forwards an SSE error event yielded by the service (unknown mid-stream failures) without throwing', async () => {
      const qaChainService = makeMockQaChainService();
      qaChainService.askStream.mockImplementation(async function* () {
        await Promise.resolve();
        yield { type: 'sources', data: [] };
        // askStream converts unknown mid-stream errors to this SSE event
        // internally — controller should treat it like any other yielded
        // event (next + complete normally, no Observable error).
        yield {
          type: 'error',
          data: { code: 'STREAM_FAILED', message: 'Stream failed. Reference: abc-123' },
        };
      });

      const { controller } = await buildController(qaChainService);
      const { events, error } = await collectObservable(
        controller.askStream(makeStreamQuery('a valid question')),
      );

      expect(error).toBeUndefined();
      expect(events.map((e) => e.data)).toEqual([
        '{"type":"sources","data":[]}',
        '{"type":"error","data":{"code":"STREAM_FAILED","message":"Stream failed. Reference: abc-123"}}',
      ]);
    });
  });
});
