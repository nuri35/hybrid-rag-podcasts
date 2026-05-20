import { Test } from '@nestjs/testing';
import { ChromaUnreachableException } from '../vector-store/exceptions';
import { RetrievalFailedException } from '../retrieval/exceptions';
import { AskQuestionDto } from './dto/ask-question.dto';
import { QaChainFailedException } from './exceptions';
import { QaChainService } from './qa-chain.service';
import { QaController } from './qa.controller';
import type { QaResult } from './qa.types';

interface MockQaChainService {
  ask: jest.Mock<Promise<QaResult>, [string, { topK?: number } | undefined]>;
}

function makeMockQaChainService(): MockQaChainService {
  return {
    ask: jest.fn<Promise<QaResult>, [string, { topK?: number } | undefined]>(),
  };
}

async function buildController(
  qaChainService: MockQaChainService = makeMockQaChainService(),
): Promise<{ controller: QaController; qaChainService: MockQaChainService }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [QaController],
    providers: [{ provide: QaChainService, useValue: qaChainService }],
  }).compile();

  return {
    controller: moduleRef.get(QaController),
    qaChainService,
  };
}

function makeDto(question: string, topK?: number): AskQuestionDto {
  const dto = new AskQuestionDto();
  dto.question = question;
  if (topK !== undefined) dto.topK = topK;
  return dto;
}

describe('QaController', () => {
  it('delegates to QaChainService.ask() with question + topK from DTO', async () => {
    const expected: QaResult = {
      answer: 'mock answer',
      sources: [
        {
          chunkId: 'ep_001_chunk_0',
          score: 0.91,
          excerpt: 'chunk excerpt',
          metadata: { episode_id: 'ep_001' },
        },
      ],
    };
    const qaChainService = makeMockQaChainService();
    qaChainService.ask.mockResolvedValue(expected);

    const { controller } = await buildController(qaChainService);
    const result = await controller.ask(makeDto('What is consciousness?', 3));

    expect(qaChainService.ask).toHaveBeenCalledTimes(1);
    expect(qaChainService.ask).toHaveBeenCalledWith('What is consciousness?', { topK: 3 });
    expect(result).toBe(expected);
  });

  it('passes topK as undefined when DTO omits it (service applies default)', async () => {
    const qaChainService = makeMockQaChainService();
    qaChainService.ask.mockResolvedValue({ answer: 'x', sources: [] });

    const { controller } = await buildController(qaChainService);
    await controller.ask(makeDto('a valid question'));

    expect(qaChainService.ask).toHaveBeenCalledWith('a valid question', { topK: undefined });
  });

  it('returns canned no-info result unchanged (sources: [])', async () => {
    const canned: QaResult = {
      answer: "I don't have enough information to answer this question.",
      sources: [],
    };
    const qaChainService = makeMockQaChainService();
    qaChainService.ask.mockResolvedValue(canned);

    const { controller } = await buildController(qaChainService);
    const result = await controller.ask(makeDto('off-topic question'));

    expect(result).toBe(canned);
    expect(result.sources).toEqual([]);
  });

  it.each([
    ['QaChainFailedException', new QaChainFailedException('upstream LLM outage')],
    ['RetrievalFailedException', new RetrievalFailedException('chroma query failed')],
    [
      'ChromaUnreachableException',
      new ChromaUnreachableException('http://localhost:8000', 'ECONNREFUSED'),
    ],
  ])('propagates %s from service unchanged', async (_label, error) => {
    const qaChainService = makeMockQaChainService();
    qaChainService.ask.mockRejectedValue(error);

    const { controller } = await buildController(qaChainService);
    const caught = await controller.ask(makeDto('a valid question')).catch((e: unknown) => e);

    expect(caught).toBe(error);
  });
});
