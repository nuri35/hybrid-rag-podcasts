import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Runnable } from '@langchain/core/runnables';
import { EmbedderService } from '../ingestion/services/embedder.service';
import {
  ChromaRepository,
  type SimilarityResult,
} from '../vector-store/chroma.repository';
import {
  ChromaUnreachableException,
} from '../vector-store/exceptions';
import { EmbeddingFailedException } from '../../common/exceptions';
import {
  EmptyQueryException,
  InvalidRetrievalOptionsException,
  QueryTooLongException,
  QueryTooShortException,
  RetrievalFailedException,
} from './exceptions';
import { VectorRetrieverService } from './vector-retriever.service';

interface ConfigOverrides {
  RETRIEVAL_DEFAULT_TOP_K?: number;
  RETRIEVAL_MAX_TOP_K?: number;
  RETRIEVAL_MIN_QUERY_LENGTH?: number;
  RETRIEVAL_MAX_QUERY_LENGTH?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    RETRIEVAL_DEFAULT_TOP_K: 5,
    RETRIEVAL_MAX_TOP_K: 50,
    RETRIEVAL_MIN_QUERY_LENGTH: 3,
    RETRIEVAL_MAX_QUERY_LENGTH: 1000,
    ...overrides,
  };
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

interface MockEmbedder {
  embedQuery: jest.Mock<Promise<number[]>, [string]>;
}

interface MockChroma {
  similaritySearch: jest.Mock<
    Promise<SimilarityResult[]>,
    [number[], number, Record<string, unknown> | undefined]
  >;
}

function makeMockEmbedder(): MockEmbedder {
  return { embedQuery: jest.fn<Promise<number[]>, [string]>() };
}

function makeMockChroma(): MockChroma {
  return {
    similaritySearch: jest.fn<
      Promise<SimilarityResult[]>,
      [number[], number, Record<string, unknown> | undefined]
    >(),
  };
}

async function buildService(
  configOverrides: ConfigOverrides = {},
  embedder: MockEmbedder = makeMockEmbedder(),
  chroma: MockChroma = makeMockChroma(),
): Promise<{
  service: VectorRetrieverService;
  embedder: MockEmbedder;
  chroma: MockChroma;
}> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      VectorRetrieverService,
      { provide: EmbedderService, useValue: embedder },
      { provide: ChromaRepository, useValue: chroma },
      { provide: ConfigService, useValue: makeConfig(configOverrides) },
    ],
  }).compile();
  const service = moduleRef.get(VectorRetrieverService);
  return { service, embedder, chroma };
}

function fakeSearchResult(
  id: string,
  score: number,
  document: string,
  chunkIndex: number,
  episodeId = 'ep_001',
): SimilarityResult {
  return {
    id,
    score,
    document,
    metadata: { episode_id: episodeId, chunk_index: chunkIndex },
  };
}

describe('VectorRetrieverService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('returns RetrievedChunk[] for a valid query', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    chroma.similaritySearch.mockResolvedValue([
      fakeSearchResult('ep_001_chunk_0', 0.95, 'doc one', 0),
      fakeSearchResult('ep_001_chunk_1', 0.88, 'doc two', 1),
      fakeSearchResult('ep_001_chunk_2', 0.71, 'doc three', 2),
    ]);
    const { service } = await buildService({}, embedder, chroma);

    const chunks = await service.retrieve('What is consciousness?', { topK: 3 });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      id: 'ep_001_chunk_0',
      document: 'doc one',
      score: 0.95,
      metadata: { episode_id: 'ep_001', chunk_index: 0 },
      chunkIndex: 0,
    });
    expect(embedder.embedQuery).toHaveBeenCalledWith('What is consciousness?');
    expect(chroma.similaritySearch).toHaveBeenCalledWith([0.1, 0.2, 0.3], 3, undefined);
  });

  it('throws EmptyQueryException for an empty string', async () => {
    const { service } = await buildService();
    await expect(service.retrieve('')).rejects.toBeInstanceOf(EmptyQueryException);
  });

  it('throws EmptyQueryException for whitespace-only query', async () => {
    const { service } = await buildService();
    await expect(service.retrieve('   \n\t  ')).rejects.toBeInstanceOf(EmptyQueryException);
  });

  it('throws QueryTooShortException for query shorter than minQueryLength', async () => {
    const { service } = await buildService({ RETRIEVAL_MIN_QUERY_LENGTH: 5 });
    await expect(service.retrieve('hi')).rejects.toBeInstanceOf(QueryTooShortException);
  });

  it('throws QueryTooLongException for query longer than maxQueryLength', async () => {
    const { service } = await buildService({ RETRIEVAL_MAX_QUERY_LENGTH: 20 });
    const overflow = 'x'.repeat(25);
    await expect(service.retrieve(overflow)).rejects.toBeInstanceOf(QueryTooLongException);
  });

  it('throws InvalidRetrievalOptionsException when topK exceeds RETRIEVAL_MAX_TOP_K', async () => {
    const { service } = await buildService({ RETRIEVAL_MAX_TOP_K: 10 });
    await expect(service.retrieve('valid query', { topK: 25 })).rejects.toBeInstanceOf(
      InvalidRetrievalOptionsException,
    );
  });

  it('throws InvalidRetrievalOptionsException when topK is less than 1', async () => {
    const { service } = await buildService();
    await expect(service.retrieve('valid query', { topK: 0 })).rejects.toBeInstanceOf(
      InvalidRetrievalOptionsException,
    );
  });

  it('throws InvalidRetrievalOptionsException when topK is not an integer', async () => {
    const { service } = await buildService();
    await expect(service.retrieve('valid query', { topK: 3.5 })).rejects.toBeInstanceOf(
      InvalidRetrievalOptionsException,
    );
  });

  it('applies score threshold filter when provided', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockResolvedValue([
      fakeSearchResult('a', 0.95, 'doc a', 0),
      fakeSearchResult('b', 0.85, 'doc b', 1),
      fakeSearchResult('c', 0.42, 'doc c', 2),
      fakeSearchResult('d', 0.31, 'doc d', 3),
    ]);
    const { service } = await buildService({}, embedder, chroma);

    const chunks = await service.retrieve('valid query', {
      topK: 4,
      scoreThreshold: 0.5,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('passes metadata filter through to ChromaRepository.similaritySearch', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockResolvedValue([]);
    const { service } = await buildService({}, embedder, chroma);

    await service.retrieve('valid query', {
      topK: 5,
      filter: { episode_id: 'ep_007' },
    });

    expect(chroma.similaritySearch).toHaveBeenCalledWith([0.1], 5, { episode_id: 'ep_007' });
  });

  it('wraps unknown errors in RetrievalFailedException', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockRejectedValue(new Error('unexpected DB explosion'));
    const { service } = await buildService({}, embedder, chroma);

    const caught = await service.retrieve('valid query').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RetrievalFailedException);
    expect(caught).toMatchObject({ message: expect.stringContaining('unexpected DB explosion') });
  });

  it('re-throws EmbeddingFailedException without wrapping', async () => {
    const embedder = makeMockEmbedder();
    embedder.embedQuery.mockRejectedValue(new EmbeddingFailedException(0, 1, 1));
    const { service } = await buildService({}, embedder);

    const caught = await service.retrieve('valid query').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    expect(caught).not.toBeInstanceOf(RetrievalFailedException);
  });

  it('re-throws ChromaUnreachableException without wrapping', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockRejectedValue(
      new ChromaUnreachableException('http://localhost:8000', 'ECONNREFUSED'),
    );
    const { service } = await buildService({}, embedder, chroma);

    const caught = await service.retrieve('valid query').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ChromaUnreachableException);
    expect(caught).not.toBeInstanceOf(RetrievalFailedException);
  });

  it('uses default topK when options.topK is undefined', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockResolvedValue([]);
    const { service } = await buildService({ RETRIEVAL_DEFAULT_TOP_K: 7 }, embedder, chroma);

    await service.retrieve('valid query');

    expect(chroma.similaritySearch).toHaveBeenCalledWith([0.1], 7, undefined);
  });

  it('mapToRetrievedChunks surfaces chunk_index from metadata as chunkIndex', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockResolvedValue([
      {
        id: 'x',
        score: 0.9,
        document: 'doc x',
        metadata: { episode_id: 'ep_x', chunk_index: 42 },
      },
      {
        id: 'y',
        score: 0.8,
        document: 'doc y',
        metadata: { episode_id: 'ep_y' /* no chunk_index */ },
      },
    ]);
    const { service } = await buildService({}, embedder, chroma);

    const chunks = await service.retrieve('valid query', { topK: 2 });

    expect(chunks[0].chunkIndex).toBe(42);
    // Falls back to array index when chunk_index missing from metadata.
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it('logs warning when chunk_index is missing from metadata (fallback to array idx)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const embedder = makeMockEmbedder();
      const chroma = makeMockChroma();
      embedder.embedQuery.mockResolvedValue([0.1]);
      chroma.similaritySearch.mockResolvedValue([
        {
          id: 'no_idx_chunk',
          score: 0.8,
          document: 'doc with no chunk_index',
          metadata: { episode_id: 'ep_z' }, // chunk_index deliberately missing
        },
      ]);
      const { service } = await buildService({}, embedder, chroma);

      const chunks = await service.retrieve('valid query', { topK: 1 });

      expect(chunks[0].chunkIndex).toBe(0); // fell back to array index
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0][0] as string;
      expect(warnArg).toContain('metadata_chunk_index_fallback');
      expect(warnArg).toContain('id=no_idx_chunk');
      expect(warnArg).toContain('expected_key=chunk_index');
      expect(warnArg).toContain('received_type=undefined');
      expect(warnArg).toContain('using_array_idx=0');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs warning when chunk_index is a non-number type (string)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const embedder = makeMockEmbedder();
      const chroma = makeMockChroma();
      embedder.embedQuery.mockResolvedValue([0.1]);
      chroma.similaritySearch.mockResolvedValue([
        {
          id: 'string_idx_chunk',
          score: 0.7,
          document: 'doc with stringified chunk_index',
          metadata: { episode_id: 'ep_q', chunk_index: '5' }, // wrong type
        },
      ]);
      const { service } = await buildService({}, embedder, chroma);

      const chunks = await service.retrieve('valid query', { topK: 1 });

      // String '5' is rejected; falls back to array index 0, NOT 5.
      expect(chunks[0].chunkIndex).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0][0] as string;
      expect(warnArg).toContain('metadata_chunk_index_fallback');
      expect(warnArg).toContain('id=string_idx_chunk');
      expect(warnArg).toContain('received_type=string');
      expect(warnArg).toContain('using_array_idx=0');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('toRunnable returns a Runnable that produces chunks when invoked', async () => {
    const embedder = makeMockEmbedder();
    const chroma = makeMockChroma();
    embedder.embedQuery.mockResolvedValue([0.1]);
    chroma.similaritySearch.mockResolvedValue([
      fakeSearchResult('ep_001_chunk_0', 0.9, 'doc', 0),
    ]);
    const { service } = await buildService({}, embedder, chroma);

    const runnable: Runnable<string, ReturnType<typeof service.retrieve> extends Promise<infer R> ? R : never> =
      service.toRunnable({ topK: 1 });
    const result = await runnable.invoke('valid query');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ep_001_chunk_0');
    expect(chroma.similaritySearch).toHaveBeenCalledWith([0.1], 1, undefined);
  });
});
