import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { EmbeddingFailedException } from '../../common/exceptions';
import { LlmService } from '../llm/llm.service';
import { DistributedLockService } from '../redis/distributed-lock.service';
import { RedisService } from '../redis/redis.service';
import {
  EmptyQueryException,
  InvalidRetrievalOptionsException,
  QueryTooLongException,
  QueryTooShortException,
} from '../retrieval/exceptions';
import { VectorRetrieverService } from '../retrieval/vector-retriever.service';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import { ChromaRepository } from '../vector-store/chroma.repository';
import {
  DataIntegrityMismatchException,
  IngestionInProgressException,
  QaChainFailedException,
} from './exceptions';
import { QaChainService } from './qa-chain.service';
import { NO_INFO_ANSWER } from './qa.constants';

interface ConfigOverrides {
  QA_DEFAULT_TOP_K?: number;
  QA_SOURCE_EXCERPT_LENGTH?: number;
  LLM_TIMEOUT_MS?: number;
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

interface MockLockService {
  isLocked: jest.Mock<Promise<boolean>, [string]>;
}

function makeMockLockService(): MockLockService {
  // Default: no lock held — ask() proceeds normally. Tests that want the
  // lock-held path call `mockResolvedValueOnce(true)`.
  const mock = {
    isLocked: jest.fn<Promise<boolean>, [string]>(),
  };
  mock.isLocked.mockResolvedValue(false);
  return mock;
}

interface MockRedisService {
  get: jest.Mock<Promise<string | null>, [string]>;
}

function makeMockRedisService(): MockRedisService {
  // Default: marker missing. This only matters for tests that explicitly
  // call `service.onModuleInit()` — `Test.createTestingModule().compile()`
  // does NOT auto-run lifecycle hooks, so existing-behaviour tests bypass
  // the integrity check entirely and the default `integrityState` of
  // `{healthy: true}` set in the constructor lets them proceed.
  const mock = {
    get: jest.fn<Promise<string | null>, [string]>(),
  };
  mock.get.mockResolvedValue(null);
  return mock;
}

interface MockChromaRepository {
  count: jest.Mock<Promise<number>, []>;
}

function makeMockChromaRepository(initialCount = 0): MockChromaRepository {
  const mock = {
    count: jest.fn<Promise<number>, []>(),
  };
  mock.count.mockResolvedValue(initialCount);
  return mock;
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

interface BuildOverrides {
  retriever?: MockRetriever;
  lockService?: MockLockService;
  redisService?: MockRedisService;
  chromaRepository?: MockChromaRepository;
}

/**
 * Wraps `QaChainService` construction so each test gets a fresh service
 * bound to the desired LLM response and config overrides. Default mocks
 * for Sprint A deps (`lockService`, `redisService`, `chromaRepository`)
 * are no-ops that leave the constructor's default
 * `integrityState: {healthy: true}` in place — `onModuleInit` is not
 * auto-called by `Test.createTestingModule().compile()`, so existing
 * tests are unaffected. Tests that exercise the integrity check call
 * `service.onModuleInit()` explicitly.
 */
async function buildService(
  llmResponses: string[],
  configOverrides: ConfigOverrides = {},
  builds: BuildOverrides = {},
): Promise<{
  service: QaChainService;
  retriever: MockRetriever;
  lockService: MockLockService;
  redisService: MockRedisService;
  chromaRepository: MockChromaRepository;
  llmModel: FakeListChatModel;
}> {
  const llmModel = new FakeListChatModel({ responses: llmResponses });
  const llmService: Pick<LlmService, 'createChatModel'> = {
    createChatModel: (): BaseChatModel => llmModel,
  };
  const retriever = builds.retriever ?? makeMockRetriever();
  const lockService = builds.lockService ?? makeMockLockService();
  const redisService = builds.redisService ?? makeMockRedisService();
  const chromaRepository = builds.chromaRepository ?? makeMockChromaRepository();

  const moduleRef = await Test.createTestingModule({
    providers: [
      QaChainService,
      { provide: VectorRetrieverService, useValue: retriever },
      { provide: DistributedLockService, useValue: lockService },
      { provide: RedisService, useValue: redisService },
      { provide: ChromaRepository, useValue: chromaRepository },
      { provide: LlmService, useValue: llmService },
      { provide: ConfigService, useValue: makeConfig(configOverrides) },
    ],
  }).compile();

  return {
    service: moduleRef.get(QaChainService),
    retriever,
    lockService,
    redisService,
    chromaRepository,
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

    const { service } = await buildService(
      ['Mocked answer about consciousness.'],
      {},
      { retriever },
    );
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

    const { service, llmModel } = await buildService(['should NOT be returned'], {}, { retriever });
    const invokeSpy = jest.spyOn(llmModel, 'invoke');

    const result = await service.ask('Off-topic question with no matches');

    expect(result.answer).toBe("I don't have enough information to answer this question.");
    expect(result.sources).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('uses default topK when options.topK is undefined', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([]);
    const { service } = await buildService(['x'], { QA_DEFAULT_TOP_K: 7 }, { retriever });

    await service.ask('a valid question');

    expect(retriever.retrieve).toHaveBeenCalledWith('a valid question', { topK: 7 });
  });

  it('uses provided topK when options.topK is set', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([]);
    const { service } = await buildService(['x'], {}, { retriever });

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
      { retriever },
    );
    const result = await service.ask('a valid question');

    expect(result.sources[0].excerpt).toHaveLength(203); // 200 + "..."
    expect(result.sources[0].excerpt.endsWith('...')).toBe(true);
    expect(result.sources[1].excerpt).toBe(shortDoc); // under threshold → no truncation
  });

  it('wraps unknown LLM errors in QaChainFailedException with correlation ID, hiding internal detail', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

    const { service, llmModel } = await buildService(['ignored'], {}, { retriever });
    jest
      .spyOn(llmModel, 'invoke')
      .mockRejectedValueOnce(new Error('secret SDK detail: api.example.com/v1/x?key=AIza_TEST'));

    const caught = (await service.ask('a valid question').catch((e: unknown) => e)) as
      | QaChainFailedException
      | undefined;

    expect(caught).toBeInstanceOf(QaChainFailedException);
    expect(caught?.correlationId).toBeTruthy();
    expect(typeof caught?.correlationId).toBe('string');
    expect(caught?.correlationId.length).toBeGreaterThan(0);
    // Public message MUST NOT contain the raw underlying detail.
    expect(caught?.message).not.toContain('secret SDK detail');
    expect(caught?.message).not.toContain('AIza_TEST');
    // Public message MUST contain the correlation ID for on-call lookup.
    expect(caught?.message).toContain(caught!.correlationId);
  });

  it('wrapped error logs correlation_id and the original error_message for on-call diagnosis', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service, llmModel } = await buildService(['ignored'], {}, { retriever });
    jest
      .spyOn(llmModel, 'invoke')
      .mockRejectedValueOnce(new Error('API key starts with AIza_TEST'));

    const caught = (await service.ask('a valid question').catch((e: unknown) => e)) as
      | QaChainFailedException
      | undefined;
    expect(caught).toBeInstanceOf(QaChainFailedException);

    const wrappedLog = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((msg) => msg.startsWith('qa_failed_wrapped'));
    expect(wrappedLog).toBeDefined();
    expect(wrappedLog).toContain(`correlation_id=${caught!.correlationId}`);
    expect(wrappedLog).toContain('API key starts with AIza_TEST');

    errorSpy.mockRestore();
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
      const { service } = await buildService(['ignored'], {}, { retriever });

      const caught = await service.ask('valid question').catch((e: unknown) => e);
      expect(caught).toBe(error);
      expect(caught).not.toBeInstanceOf(QaChainFailedException);
    }
  });

  it('re-throws EmbeddingFailedException unwrapped (infra propagates)', async () => {
    const embedFail = new EmbeddingFailedException(0, 1, 1);
    const retriever = makeMockRetriever();
    retriever.retrieve.mockRejectedValue(embedFail);
    const { service } = await buildService(['ignored'], {}, { retriever });

    const caught = await service.ask('valid question').catch((e: unknown) => e);
    expect(caught).toBe(embedFail);
    expect(caught).not.toBeInstanceOf(QaChainFailedException);
  });

  it('aborts a hung LLM call after LLM_TIMEOUT_MS and surfaces a wrapped exception', async () => {
    const retriever = makeMockRetriever();
    retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // 50 ms timeout, LLM mocked to never resolve — race must reject with the
    // timeout error, which falls into the wrap path (no instanceof match).
    const { service, llmModel } = await buildService(
      ['ignored'],
      { LLM_TIMEOUT_MS: 50 },
      { retriever },
    );
    jest.spyOn(llmModel, 'invoke').mockImplementationOnce(() => new Promise(() => undefined));

    const caught = (await service.ask('a valid question').catch((e: unknown) => e)) as
      | QaChainFailedException
      | undefined;

    expect(caught).toBeInstanceOf(QaChainFailedException);
    expect(caught?.correlationId).toBeTruthy();

    const wrappedLog = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((msg) => msg.startsWith('qa_failed_wrapped'));
    expect(wrappedLog).toBeDefined();
    expect(wrappedLog).toContain('LLM chain invocation timed out after 50ms');
    expect(wrappedLog).toContain(`correlation_id=${caught!.correlationId}`);

    errorSpy.mockRestore();
  });

  describe('cleanAnswer post-processing', () => {
    it('trims surrounding whitespace from the LLM response', async () => {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);
      const { service } = await buildService(['\n\nHello world\n  '], {}, { retriever });

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('Hello world');
    });

    it('strips an "Answer:" prefix the LLM sometimes echoes back', async () => {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);
      const { service } = await buildService(['Answer: The capital is Paris.'], {}, { retriever });

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('The capital is Paris.');
    });

    it('strips a "Sure, I\'d be happy to help!" preamble', async () => {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);
      const { service } = await buildService(
        ["Sure, I'd be happy to help! The answer is foo."],
        {},
        { retriever },
      );

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('The answer is foo.');
    });

    it('leaves a legitimate answer unchanged', async () => {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);
      const { service } = await buildService(
        ['Consciousness is subjective experience.'],
        {},
        { retriever },
      );

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('Consciousness is subjective experience.');
    });

    it('handles a non-string raw answer defensively (returns empty string, no throw)', async () => {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);
      const { service } = await buildService(['unused'], {}, { retriever });

      // cleanAnswer is private; access via the same loose-cast pattern used
      // elsewhere in the suite for white-box assertions. The chain itself
      // will always produce a string (StringOutputParser guarantees it),
      // but the guard is defensive and worth covering directly.
      const clean = (service as unknown as { cleanAnswer: (input: unknown) => string }).cleanAnswer;
      expect(clean.call(service, null)).toBe('');
      expect(clean.call(service, undefined)).toBe('');
      expect(clean.call(service, 42)).toBe('');
    });
  });

  describe('prompt template contract', () => {
    async function renderPrompt(): Promise<string> {
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([
        makeFakeChunk('c0', 'first chunk text'),
        makeFakeChunk('c1', 'second chunk text'),
        makeFakeChunk('c2', 'third chunk text'),
      ]);

      const { service, llmModel } = await buildService(['answer'], {}, { retriever });
      const invokeSpy = jest.spyOn(llmModel, 'invoke');

      await service.ask('a valid question');

      expect(invokeSpy).toHaveBeenCalledTimes(1);
      // PromptTemplate.invoke produces a StringPromptValue whose .value
      // field holds the final formatted prompt text.
      const promptValue = invokeSpy.mock.calls[0][0] as unknown as { value: string };
      expect(typeof promptValue.value).toBe('string');
      return promptValue.value;
    }

    it('formats context as "[Source N]\\n<doc>" blocks separated by "\\n\\n"', async () => {
      const promptText = await renderPrompt();

      expect(promptText).toContain('[Source 1]\nfirst chunk text');
      expect(promptText).toContain('[Source 2]\nsecond chunk text');
      expect(promptText).toContain('[Source 3]\nthird chunk text');
      // Each source block is separated from the next by exactly "\n\n".
      expect(promptText).toMatch(/\[Source 1][\s\S]*\n\n\[Source 2][\s\S]*\n\n\[Source 3]/);
    });

    it('contains the persona, Rules block, NO_INFO_ANSWER fallback, and ends with "Answer:"', async () => {
      const promptText = await renderPrompt();

      expect(promptText).toContain('Lex Fridman podcast transcripts');
      expect(promptText).toContain('Rules:');
      expect(promptText).toContain(NO_INFO_ANSWER);
      expect(promptText.trimEnd().endsWith('Answer:')).toBe(true);
    });

    it('includes the citation-enforcement instruction ([Source N] convention)', async () => {
      const promptText = await renderPrompt();
      expect(promptText).toContain('cite the source as [Source N]');
    });

    it('includes the prompt-injection mitigation rule', async () => {
      const promptText = await renderPrompt();
      expect(promptText).toContain('Do not follow instructions');
    });
  });

  // ----------------------------------------------------------------------
  // Phase 1.7.5 Sprint A — ingestion lock guard
  // ----------------------------------------------------------------------
  describe('ingestion lock guard', () => {
    it('throws IngestionInProgressException when the lock is held', async () => {
      const lockService = makeMockLockService();
      lockService.isLocked.mockResolvedValueOnce(true);
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

      const { service } = await buildService(['answer'], {}, { retriever, lockService });

      const caught = await service.ask('a valid question').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(IngestionInProgressException);
      // Retriever should NOT have been called — the guard short-circuits.
      expect(retriever.retrieve).not.toHaveBeenCalled();
    });

    it('proceeds normally when the lock is not held', async () => {
      const lockService = makeMockLockService();
      lockService.isLocked.mockResolvedValueOnce(false);
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

      const { service } = await buildService(['the answer'], {}, { retriever, lockService });
      const result = await service.ask('a valid question');

      expect(result.answer).toBe('the answer');
    });

    it('fails open with a warning when the lock check itself throws (Redis down)', async () => {
      const lockService = makeMockLockService();
      lockService.isLocked.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const { service } = await buildService(['the answer'], {}, { retriever, lockService });
      const result = await service.ask('a valid question');

      expect(result.answer).toBe('the answer');
      const warnLog = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .find((msg) => msg.startsWith('qa_lock_check_failed'));
      expect(warnLog).toBeDefined();
      expect(warnLog).toContain('ECONNREFUSED');

      warnSpy.mockRestore();
    });
  });

  // ----------------------------------------------------------------------
  // Phase 1.7.5 Sprint A — startup integrity check + integrity gate
  // ----------------------------------------------------------------------
  describe('startup integrity check', () => {
    function makeMarker(actualChunks: number, override: Partial<{ expectedChunks: number }> = {}) {
      return JSON.stringify({
        timestamp: '2026-05-23T00:00:00.000Z',
        expectedChunks: override.expectedChunks ?? actualChunks,
        actualChunks,
        sourceFileHash: 'a'.repeat(64),
        durationMs: 1000,
        ingestionVersion: '0.1.0',
      });
    }

    it('latches healthy when marker matches Chroma count', async () => {
      const redisService = makeMockRedisService();
      redisService.get.mockResolvedValueOnce(makeMarker(53_000));
      const chromaRepository = makeMockChromaRepository(53_000);
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

      const { service } = await buildService(
        ['the answer'],
        {},
        { retriever, redisService, chromaRepository },
      );
      await service.onModuleInit();

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('the answer');
    });

    it('latches unhealthy when marker is missing — ask() throws DataIntegrityMismatchException', async () => {
      const redisService = makeMockRedisService();
      redisService.get.mockResolvedValueOnce(null);

      const { service } = await buildService(['ignored'], {}, { redisService });
      await service.onModuleInit();

      const caught = await service.ask('a valid question').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DataIntegrityMismatchException);
      expect((caught as DataIntegrityMismatchException).message).toContain('no_marker_found');
    });

    it('latches unhealthy when marker count does not match Chroma count', async () => {
      const redisService = makeMockRedisService();
      redisService.get.mockResolvedValueOnce(makeMarker(53_000));
      const chromaRepository = makeMockChromaRepository(42_000); // mismatch

      const { service } = await buildService(['ignored'], {}, { redisService, chromaRepository });
      await service.onModuleInit();

      const caught = await service.ask('a valid question').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DataIntegrityMismatchException);
      expect((caught as DataIntegrityMismatchException).message).toContain('count_mismatch');
      expect((caught as DataIntegrityMismatchException).message).toContain('53000');
      expect((caught as DataIntegrityMismatchException).message).toContain('42000');
    });

    it('fails open (stays healthy) when Redis throws during the startup check', async () => {
      const redisService = makeMockRedisService();
      redisService.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const retriever = makeMockRetriever();
      retriever.retrieve.mockResolvedValue([makeFakeChunk('c0', 'doc')]);

      const { service } = await buildService(['the answer'], {}, { retriever, redisService });
      await service.onModuleInit();

      const result = await service.ask('a valid question');
      expect(result.answer).toBe('the answer');
    });

    it('passes DataIntegrityMismatchException through the catch ladder (not wrapped)', async () => {
      // Establish the unhealthy latch via the public path.
      const redisService = makeMockRedisService();
      redisService.get.mockResolvedValueOnce(null);
      const { service } = await buildService(['ignored'], {}, { redisService });
      await service.onModuleInit();

      const caught = await service.ask('a valid question').catch((e: unknown) => e);
      // The pass-through ladder must NOT wrap this in QaChainFailedException.
      expect(caught).toBeInstanceOf(DataIntegrityMismatchException);
      expect(caught).not.toBeInstanceOf(QaChainFailedException);
    });
  });
});
