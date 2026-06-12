import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ElasticsearchService } from './elasticsearch.service';
import {
  DEFAULT_TOP_K,
  ELASTICSEARCH_CLIENT,
  INDEX_NAME,
} from './elasticsearch.constants';

/**
 * Minimal mock of the parts of `@elastic/elasticsearch` Client the service
 * touches: `search()` and `cluster.health()`.
 */
interface MockClient {
  search: jest.Mock;
  cluster: { health: jest.Mock };
}

function buildMockClient(): MockClient {
  return {
    search: jest.fn(),
    cluster: { health: jest.fn() },
  };
}

/** A realistic single-hit ES response for the q017 ground-truth chunk. */
function sampleResponse() {
  return {
    hits: {
      hits: [
        {
          _id: '269_chunk_306',
          _score: 28.291,
          _source: {
            text: 'A constructor is different from an abstractor in that...',
            chunk_id: '269_chunk_306',
            chunk_index: 306,
            total_chunks: 400,
            episode_id: '269',
            title: 'Assembly Theory',
            date: '',
            guest_name: 'Lee Cronin',
            guest_affiliation: 'University of Glasgow',
            guest_role: 'Chemist',
            duration_min: 180,
          },
        },
      ],
    },
  };
}

describe('ElasticsearchService', () => {
  let service: ElasticsearchService;
  let client: MockClient;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    client = buildMockClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ElasticsearchService,
        { provide: ELASTICSEARCH_CLIENT, useValue: client },
      ],
    }).compile();
    service = moduleRef.get(ElasticsearchService);
    // Silence + observe logs.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('search() — mapping', () => {
    it('maps a realistic ES response to RetrievedChunk shape (symmetric with vector side)', async () => {
      client.search.mockResolvedValue(sampleResponse());

      const result = await service.search('constructors abstractors', 5);

      expect(result).toHaveLength(1);
      const hit = result[0];
      expect(hit.id).toBe('269_chunk_306');
      expect(hit.document).toBe('A constructor is different from an abstractor in that...');
      expect(hit.score).toBe(28.291);
      expect(hit.chunkIndex).toBe(306);
      // metadata = _source minus text → same key set as Chroma metadata.
      expect(hit.metadata).not.toHaveProperty('text');
      expect(hit.metadata.episode_id).toBe('269');
      expect(hit.metadata.guest_name).toBe('Lee Cronin');
      expect(hit.metadata.chunk_id).toBe('269_chunk_306');
      expect(hit.metadata.chunk_index).toBe(306);
    });

    it('returns [] for an empty hit list', async () => {
      client.search.mockResolvedValue({ hits: { hits: [] } });
      await expect(service.search('nothing matches')).resolves.toEqual([]);
    });

    it('falls back to array index + warns when chunk_index is missing/non-numeric', async () => {
      client.search.mockResolvedValue({
        hits: {
          hits: [
            {
              _id: 'x_chunk_0',
              _score: 1.0,
              _source: { text: 'body', chunk_id: 'x_chunk_0', episode_id: '5' },
            },
          ],
        },
      });

      const result = await service.search('q');

      expect(result[0].chunkIndex).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('es_metadata_chunk_index_fallback'),
      );
    });
  });

  describe('search() — query DSL + topK', () => {
    it('passes topK through as ES `size` and queries a match on text', async () => {
      client.search.mockResolvedValue({ hits: { hits: [] } });

      await service.search('Turing machine', 7);

      expect(client.search).toHaveBeenCalledTimes(1);
      const [params] = client.search.mock.calls[0];
      expect(params.index).toBe(INDEX_NAME);
      expect(params.size).toBe(7);
      expect(params.query).toEqual({ match: { text: 'Turing machine' } });
    });

    it('defaults size to DEFAULT_TOP_K when topK is omitted', async () => {
      client.search.mockResolvedValue({ hits: { hits: [] } });

      await service.search('Turing machine');

      const [params] = client.search.mock.calls[0];
      expect(params.size).toBe(DEFAULT_TOP_K);
    });
  });

  describe('search() — empty query short-circuit', () => {
    it.each(['', '   ', '\n\t'])('returns [] without calling the client for %j', async (q) => {
      const result = await service.search(q);
      expect(result).toEqual([]);
      expect(client.search).not.toHaveBeenCalled();
    });
  });

  describe('search() — graceful degradation', () => {
    it('returns [] and warns on a connection error', async () => {
      client.search.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9200'));

      const result = await service.search('Turing machine');

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('es_search_failed'),
      );
    });

    it('returns [] on a request timeout', async () => {
      const timeout = new Error('Request timed out');
      timeout.name = 'TimeoutError';
      client.search.mockRejectedValue(timeout);

      await expect(service.search('Turing machine')).resolves.toEqual([]);
    });

    it('returns [] when the index is missing (404)', async () => {
      client.search.mockRejectedValue(new Error('index_not_found_exception: no such index'));
      await expect(service.search('Turing machine')).resolves.toEqual([]);
    });
  });

  describe('isHealthy()', () => {
    it.each(['green', 'yellow'])('returns true on cluster status %s', async (status) => {
      client.cluster.health.mockResolvedValue({ status });
      await expect(service.isHealthy()).resolves.toBe(true);
    });

    it('returns false on cluster status red', async () => {
      client.cluster.health.mockResolvedValue({ status: 'red' });
      await expect(service.isHealthy()).resolves.toBe(false);
    });

    it('returns false (and warns) when the health call throws', async () => {
      client.cluster.health.mockRejectedValue(new Error('cluster unreachable'));
      await expect(service.isHealthy()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('es_health_check_failed'),
      );
    });
  });
});
