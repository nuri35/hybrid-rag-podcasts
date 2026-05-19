import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Document } from '@langchain/core/documents';
import { ChromaUnreachableException, ChromaWriteFailedException } from './exceptions';
import { ChromaRepository, isTransientError } from './chroma.repository';

const mockHeartbeat = jest.fn<Promise<number>, []>();
const mockGetOrCreateCollection = jest.fn<Promise<unknown>, [unknown]>();
const mockDeleteCollection = jest.fn<Promise<void>, [unknown]>();
const mockUpsert = jest.fn<Promise<void>, [unknown]>();
const mockQuery = jest.fn<Promise<unknown>, [unknown]>();
const mockCount = jest.fn<Promise<number>, []>();

let mockCollectionId = 0;

jest.mock('chromadb', () => {
  class MockChromaConnectionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ChromaConnectionError';
    }
  }
  class MockChromaServerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ChromaServerError';
    }
  }

  class MockChromaClient {
    constructor(_params: unknown) {}
    heartbeat() {
      return mockHeartbeat();
    }
    async getOrCreateCollection(params: unknown) {
      mockCollectionId += 1;
      await mockGetOrCreateCollection(params);
      return {
        name: 'mock',
        id: `col-${mockCollectionId}`,
        upsert: (p: unknown) => mockUpsert(p),
        query: (p: unknown) => mockQuery(p),
        count: () => mockCount(),
      };
    }
    deleteCollection(params: unknown) {
      return mockDeleteCollection(params);
    }
  }

  return {
    ChromaClient: MockChromaClient,
    ChromaConnectionError: MockChromaConnectionError,
    ChromaServerError: MockChromaServerError,
  };
});

interface ConfigOverrides {
  CHROMA_URL?: string;
  CHROMA_COLLECTION?: string;
  CHROMA_DISTANCE_METRIC?: 'cosine' | 'l2' | 'ip';
  CHROMA_WRITE_BATCH_SIZE?: number;
  CHROMA_WRITE_CONCURRENCY?: number;
  CHROMA_WRITE_TIMEOUT_MS?: number;
  CHROMA_WRITE_MAX_RETRIES?: number;
  CHROMA_API_KEY?: string;
  CHROMA_API_KEY_HEADER?: string;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    CHROMA_URL: 'http://localhost:8000',
    CHROMA_COLLECTION: 'test_podcasts',
    CHROMA_DISTANCE_METRIC: 'cosine',
    CHROMA_WRITE_BATCH_SIZE: 50,
    CHROMA_WRITE_CONCURRENCY: 3,
    CHROMA_WRITE_TIMEOUT_MS: 30_000,
    CHROMA_WRITE_MAX_RETRIES: 0,
    CHROMA_API_KEY: undefined,
    CHROMA_API_KEY_HEADER: 'X-Chroma-Token',
    ...overrides,
  };
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

async function buildRepo(overrides: ConfigOverrides = {}): Promise<ChromaRepository> {
  const moduleRef = await Test.createTestingModule({
    providers: [ChromaRepository, { provide: ConfigService, useValue: makeConfig(overrides) }],
  }).compile();
  return moduleRef.get(ChromaRepository);
}

function makeChunk(idx: number, episodeId: string = 'ep_001'): Document {
  return new Document({
    pageContent: `chunk content ${idx}`,
    metadata: {
      episode_id: episodeId,
      title: 'Test Episode',
      date: '2024-01-01',
      duration_min: 60,
      guest_name: 'Tester',
      guest_affiliation: 'Org',
      guest_role: 'Guest',
      chunk_id: `${episodeId}_chunk_${idx}`,
      chunk_index: idx,
      total_chunks: 100,
    },
  });
}

function makeVector(seed: number): number[] {
  return [seed, seed + 0.1, seed + 0.2];
}

describe('ChromaRepository', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    mockHeartbeat.mockReset();
    mockGetOrCreateCollection.mockReset();
    mockDeleteCollection.mockReset();
    mockUpsert.mockReset();
    mockQuery.mockReset();
    mockCount.mockReset();
    mockGetOrCreateCollection.mockResolvedValue(undefined);
    mockUpsert.mockResolvedValue(undefined);
    mockCount.mockResolvedValue(0);
  });

  it('onModuleInit succeeds when heartbeat responds', async () => {
    mockHeartbeat.mockResolvedValue(1_700_000_000);
    const repo = await buildRepo();
    await expect(repo.onModuleInit()).resolves.toBeUndefined();
    expect(mockHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('onModuleInit throws ChromaUnreachableException when heartbeat rejects', async () => {
    mockHeartbeat.mockRejectedValue(new Error('ECONNREFUSED'));
    const repo = await buildRepo();
    await expect(repo.onModuleInit()).rejects.toBeInstanceOf(ChromaUnreachableException);
  });

  it('addDocuments splits 200 chunks into 4 upsert calls when batch=50', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo({ CHROMA_WRITE_BATCH_SIZE: 50, CHROMA_WRITE_CONCURRENCY: 5 });
    const chunks = Array.from({ length: 200 }, (_, i) => makeChunk(i));
    const vectors = chunks.map((_, i) => makeVector(i));
    await repo.addDocuments(chunks, vectors);
    expect(mockUpsert).toHaveBeenCalledTimes(4);
  });

  it('addDocuments last batch holds the remainder (105 chunks, batch=50 → 50/50/5)', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo({ CHROMA_WRITE_BATCH_SIZE: 50, CHROMA_WRITE_CONCURRENCY: 5 });
    const chunks = Array.from({ length: 105 }, (_, i) => makeChunk(i));
    const vectors = chunks.map((_, i) => makeVector(i));
    await repo.addDocuments(chunks, vectors);
    expect(mockUpsert).toHaveBeenCalledTimes(3);
    const sizes = mockUpsert.mock.calls
      .map((c) => (c[0] as { ids: string[] }).ids.length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([50, 50, 5]);
  });

  it('addDocuments passes ids/embeddings/metadatas/documents mapped from chunks', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo({ CHROMA_WRITE_BATCH_SIZE: 100 });
    const chunks = [makeChunk(0, 'ep_alpha'), makeChunk(1, 'ep_alpha')];
    const vectors = [makeVector(0), makeVector(1)];
    await repo.addDocuments(chunks, vectors);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const payload = mockUpsert.mock.calls[0][0] as {
      ids: string[];
      embeddings: number[][];
      metadatas: Record<string, unknown>[];
      documents: string[];
    };
    expect(payload.ids).toEqual(['ep_alpha_chunk_0', 'ep_alpha_chunk_1']);
    expect(payload.embeddings).toEqual(vectors);
    expect(payload.documents).toEqual(['chunk content 0', 'chunk content 1']);
    expect(payload.metadatas[0]).toEqual(
      expect.objectContaining({
        episode_id: 'ep_alpha',
        chunk_id: 'ep_alpha_chunk_0',
        chunk_index: 0,
      }),
    );
  });

  it('addDocuments throws ChromaWriteFailedException with correct counters on terminal batch failure', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo({
      CHROMA_WRITE_BATCH_SIZE: 50,
      CHROMA_WRITE_CONCURRENCY: 5,
      CHROMA_WRITE_MAX_RETRIES: 0,
    });
    const chunks = Array.from({ length: 150 }, (_, i) => makeChunk(i));
    const vectors = chunks.map((_, i) => makeVector(i));
    // Three batches: succeed, fail (non-transient validation), succeed.
    mockUpsert
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('400 validation: bad payload'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const caught = await repo.addDocuments(chunks, vectors).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ChromaWriteFailedException);
    expect(caught).toMatchObject({
      writtenBatches: 2,
      totalBatches: 3,
    });
    expect((caught as ChromaWriteFailedException).failedBatches).toHaveLength(1);
  });

  it('addDocuments retries on transient error and succeeds on second attempt', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo({
      CHROMA_WRITE_BATCH_SIZE: 50,
      CHROMA_WRITE_CONCURRENCY: 1,
      CHROMA_WRITE_MAX_RETRIES: 2,
    });
    const chunks = Array.from({ length: 30 }, (_, i) => makeChunk(i));
    const vectors = chunks.map((_, i) => makeVector(i));
    const transient = new Error('503 service unavailable');
    mockUpsert.mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await repo.addDocuments(chunks, vectors);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('addDocuments respects the configured concurrency limit', async () => {
    mockHeartbeat.mockResolvedValue(0);
    let inFlight = 0;
    let maxInFlight = 0;
    mockUpsert.mockImplementation(() => {
      inFlight += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve();
        }, 30);
      });
    });
    const repo = await buildRepo({ CHROMA_WRITE_BATCH_SIZE: 50, CHROMA_WRITE_CONCURRENCY: 2 });
    const chunks = Array.from({ length: 400 }, (_, i) => makeChunk(i));
    const vectors = chunks.map((_, i) => makeVector(i));

    await repo.addDocuments(chunks, vectors);
    expect(mockUpsert).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('addDocuments throws programmer-error when chunks.length !== vectors.length', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo();
    const chunks = [makeChunk(0), makeChunk(1)];
    const vectors = [makeVector(0)];
    await expect(repo.addDocuments(chunks, vectors)).rejects.toThrow(/length mismatch/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('addDocuments returns early on empty input and logs a warning', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await repo.addDocuments([], []);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty input'));
    warnSpy.mockRestore();
  });

  it('resetCollection deletes and recreates; ignores not-found errors', async () => {
    mockHeartbeat.mockResolvedValue(0);
    mockDeleteCollection.mockRejectedValueOnce(new Error('Collection not found (404)'));
    const repo = await buildRepo();
    await expect(repo.resetCollection()).resolves.toBeUndefined();
    expect(mockDeleteCollection).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateCollection).toHaveBeenCalled();
  });

  it('similaritySearch transforms response and computes score = 1 - L2²/2 (L2-on-unit-vectors → cosine)', async () => {
    mockHeartbeat.mockResolvedValue(0);
    mockQuery.mockResolvedValue({
      ids: [['id1', 'id2']],
      embeddings: null,
      documents: [['doc one', 'doc two']],
      metadatas: [[{ episode_id: 'ep_a' }, { episode_id: 'ep_b' }]],
      distances: [[0.1, 0.4]],
      included: ['documents', 'metadatas', 'distances'],
    });
    const repo = await buildRepo();
    const results = await repo.similaritySearch([0.1, 0.2, 0.3], 2, { episode_id: 'ep_a' });
    expect(results).toHaveLength(2);
    const first = results[0];
    expect(first.id).toBe('id1');
    // distance=0.1 → score = 1 - 0.01/2 = 0.995
    expect(first.score).toBeCloseTo(0.995, 5);
    expect(first.metadata).toEqual({ episode_id: 'ep_a' });
    expect(first.document).toBe('doc one');
    // distance=0.4 → score = 1 - 0.16/2 = 0.92
    expect(results[1].score).toBeCloseTo(0.92, 5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ nResults: 2, where: { episode_id: 'ep_a' } }),
    );
  });

  it('count returns the integer from collection.count()', async () => {
    mockHeartbeat.mockResolvedValue(0);
    mockCount.mockResolvedValue(42);
    const repo = await buildRepo();
    await expect(repo.count()).resolves.toBe(42);
  });

  it('getOrCreateCollection caches after first call', async () => {
    mockHeartbeat.mockResolvedValue(0);
    const repo = await buildRepo();
    await repo.count();
    await repo.count();
    await repo.count();
    expect(mockGetOrCreateCollection).toHaveBeenCalledTimes(1);
  });

  it('isTransientError classifies 429/5xx/timeouts as transient and 4xx/auth as not', () => {
    expect(isTransientError(new Error('HTTP 429 rate limit'))).toBe(true);
    expect(isTransientError(new Error('HTTP 500 internal error'))).toBe(true);
    expect(isTransientError(new Error('HTTP 502 bad gateway'))).toBe(true);
    expect(isTransientError(new Error('HTTP 503 service unavailable'))).toBe(true);
    expect(isTransientError(new Error('HTTP 504 gateway timeout'))).toBe(true);
    expect(isTransientError(new Error('operation timed out after 30000ms'))).toBe(true);
    const econn = new Error('connection refused') as Error & { code?: string };
    econn.code = 'ECONNRESET';
    expect(isTransientError(econn)).toBe(true);

    expect(isTransientError(new Error('HTTP 400 bad request'))).toBe(false);
    expect(isTransientError(new Error('HTTP 401 unauthorized'))).toBe(false);
    expect(isTransientError(new Error('HTTP 403 forbidden'))).toBe(false);
    expect(isTransientError(new Error('HTTP 404 not found'))).toBe(false);
    expect(isTransientError('not even an error')).toBe(false);
  });
});
