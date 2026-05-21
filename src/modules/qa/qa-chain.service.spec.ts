import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { EmbeddingFailedException } from '../../common/exceptions';
import { LlmService } from '../llm/llm.service';
import {
  EmptyQueryException,
  InvalidRetrievalOptionsException,
  QueryTooLongException,
  QueryTooShortException,
} from '../retrieval/exceptions';
import { VectorRetrieverService } from '../retrieval/vector-retriever.service';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import { QaChainFailedException } from './exceptions';
import { QaChainService } from './qa-chain.service';

interface ConfigOverrides {
  QA_DEFAULT_TOP_K?: number;
  QA_SOURCE_EXCERPT_LENGTH?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    QA_DEFAULT_TOP_K: 5,
    QA_SOURCE_EXCERPT_LENGTH: 200,
    LLM_MODEL: 'fake-model',
    LLM_TEMPERATURE: 0,
    LLM_MAX_OUTPUT_TOKENS: 1024,
    LLM_TIMEOUT_MS: 30_000,
    GOOGLE_API_KEY: 'test-key',
    ...overrides,
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService;
}

interface MockRetriever {
  retrieve: jest.Mock<Promise<RetrievedChunk[]>, [string, { topK?: number } | undefined]>;
}

function makeMockRetriever(): MockRetriever {
  return {
    retrieve: jest.fn<Promise<RetrievedChunk[]>, [string, { topK?: number } | undefined]>(),
  };
}

function makeFakeChunk(
  id: string,
  document: string,
  score = 0.9,
  episodeId = 'ep_001',
): RetrievedChunk {
  return {
    id,
    document,
    score,
    metadata: { episode_id: episodeId, chunk_index: parseInt(id.split('_').pop() ?? '0', 10) },
    chunkIndex: parseInt(id.split('_').pop() ?? '0', 10),
  };
}

/**
 * Wraps `QaChainService` construction so each test gets a fresh service
 * bound to the desired LLM response and config overrides.
 */
async function buildService(
  llmResponses: string[],
  configOverrides: ConfigOverrides = {},
  retriever: MockRetriever = makeMockRetriever(),
): Promise<{
  service: QaChainService;
  retriever: MockRetriever;
  llmModel: FakeListChatModel;
}> {
  const llmModel = new FakeListChatModel({ responses: llmResponses });
  const llmService: Pick<LlmService, 'createChatModel'> = {
    createChatModel: (): BaseChatModel => llmModel,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      QaChainService,
      { provide: VectorRetrieverService, useValue: retriever },
      { provide: LlmService, useValue: llmService },
      { provide: ConfigService, useValue: makeConfig(configOverrides) },
    ],
  }).compile();

  return {
    service: moduleRef.get(QaChainService),
    retriever,
    llmModel,
  };
}

describe('QaChainService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('returns QaResult with answer and sources for a valid question', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([
      makeFakeChunk('ep_001_chunk_0', 'Consciousness is the subject of much debate.', 0.92),
      makeFakeChunk('ep_001_chunk_1', 'Some philosophers reject hard problems.', 0.85),
      makeFakeChunk('ep_002_chunk_3', 'Information integration theory says...', 0.78, 'ep_002'),
    ]);

    // Spy on Logger.prototype.log so we can assert the qa_complete payload
    // carries the score telemetry fields (top/avg/min). Overridden by
    // Logger.overrideLogger(false) above so real stdout stays quiet — the
    // spy still intercepts the call.
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const { service } = await buildService(['Mocked answer about consciousness.'], {}, retriever);
    const result = await service.ask('What is consciousness?');

    expect(result.answer).toBe('Mocked answer about consciousness.');
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0]).toEqual({
      chunkId: 'ep_001_chunk_0',
      score: 0.92,
      excerpt: 'Consciousness is the subject of much debate.',
      metadata: { episode_id: 'ep_001', chunk_index: 0 },
    });

    const qaCompleteLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((msg) => msg.startsWith('qa_complete'));
    expect(qaCompleteLog).toBeDefined();
    expect(qaCompleteLog).toContain('top_score=');
    expect(qaCompleteLog).toContain('avg_score=');
    expect(qaCompleteLog).toContain('min_score=');
    // Spot-check the values: top=0.92, min=0.78, avg=(0.92+0.85+0.78)/3=0.85
    expect(qaCompleteLog).toContain('top_score=0.9200');
    expect(qaCompleteLog).toContain('min_score=0.7800');
    expect(qaCompleteLog).toContain('avg_score=0.8500');

    logSpy.mockRestore();
  });

  it('returns canned no-info answer when retriever returns no chunks (LLM not called)', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([]);

    const { service, llmModel } = await buildService(['should NOT be returned'], {}, retriever);
    const invokeSpy = jest.spyOn(llmModel, 'invoke');

    const result = await service.ask('Off-topic question with no matches');

    expect(result.answer).toBe("I don't have enough information to answer this question.");
    expect(result.sources).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('uses default topK when options.topK is undefined', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([]);
    const { service } = await buildService(['x'], { QA_DEFAULT_TOP_K: 7 }, retriever);

    await service.ask('a valid question');

    expect(retriever.retrieve).toHaveBeenCalledWith('a valid question', { topK: 7 });
  });

  it('uses provided topK when options.topK is set', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([]);
    const { service } = await buildService(['x'], {}, retriever);

    await service.ask('a valid question', { topK: 12 });

    expect(retriever.retrieve).toHaveBeenCalledWith('a valid question', { topK: 12 });
  });

  it('truncates source excerpts to QA_SOURCE_EXCERPT_LENGTH and appends "..."', async () => {
    const longDoc = 'x'.repeat(500);
    const shortDoc = 'short text';
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([
      makeFakeChunk('long_chunk_0', longDoc),
      makeFakeChunk('short_chunk_0', shortDoc),
    ]);

    const { service } = await buildService(
      ['mocked'],
      { QA_SOURCE_EXCERPT_LENGTH: 200 },
      retriever,
    );
    const result = await service.ask('a valid question');

    expect(result.sources[0].excerpt).toHaveLength(203); // 200 + "..."
    expect(result.sources[0].excerpt.endsWith('...')).toBe(true);
    expect(result.sources[1].excerpt).toBe(shortDoc); // under threshold → no truncation
  });

  it('wraps unknown LLM errors in QaChainFailedException', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

    const { service, llmModel } = await buildService(['ignored'], {}, retriever);
    jest.spyOn(llmModel, 'invoke').mockRejectedValueOnce(new Error('upstream LLM outage'));

    const caught = await service.ask('a valid question').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(QaChainFailedException);
    expect((caught as QaChainFailedException).message).toContain('upstream LLM outage');
  });

  it('re-throws retrieval validation exceptions unwrapped', async () => {
    const cases: Array<{ name: string; error: Error }> = [
      { name: 'empty', error: new EmptyQueryException() },
      { name: 'tooShort', error: new QueryTooShortException('too short') },
      { name: 'tooLong', error: new QueryTooLongException('too long') },
      { name: 'badOptions', error: new InvalidRetrievalOptionsException('bad') },
    ];

    for (const { error } of cases) {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockRejectedValue(error);
      const { service } = await buildService(['ignored'], {}, retriever);

      const caught = await service.ask('valid question').catch((e: unknown) => e);
      expect(caught).toBe(error);
      expect(caught).not.toBeInstanceOf(QaChainFailedException);
    }
  });

  it('re-throws EmbeddingFailedException unwrapped (infra propagates)', async () => {
    const embedFail = new EmbeddingFailedException(0, 1, 1);
    const retriever = makeMockRetriever();
    retriever.retrieve.mockRejectedValue(embedFail);
    const { service } = await buildService(['ignored'], {}, retriever);

    const caught = await service.ask('valid question').catch((e: unknown) => e);
    expect(caught).toBe(embedFail);
    expect(caught).not.toBeInstanceOf(QaChainFailedException);
  });

  it('formats context as "[Source N]\\n<doc>" blocks separated by "\\n\\n"', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([
      makeFakeChunk('c0', 'first chunk text'),
      makeFakeChunk('c1', 'second chunk text'),
      makeFakeChunk('c2', 'third chunk text'),
    ]);

    const { service, llmModel } = await buildService(['answer'], {}, retriever);
    const invokeSpy = jest.spyOn(llmModel, 'invoke');

    await service.ask('a valid question');

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    // PromptTemplate.invoke produces a StringPromptValue whose .value field
    // holds the final formatted prompt text. We assert that contract first,
    // then inspect the value directly.
    const promptValue = invokeSpy.mock.calls[0][0] as unknown as { value: string };
    expect(typeof promptValue.value).toBe('string');
    const promptText = promptValue.value;

    expect(promptText).toContain('[Source 1]\nfirst chunk text');
    expect(promptText).toContain('[Source 2]\nsecond chunk text');
    expect(promptText).toContain('[Source 3]\nthird chunk text');
    // Each source block is separated from the next by exactly "\n\n".
    expect(promptText).toMatch(/\[Source 1][\s\S]*\n\n\[Source 2][\s\S]*\n\n\[Source 3]/);
  });
});
