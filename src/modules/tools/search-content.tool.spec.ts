import { Logger } from '@nestjs/common';
import { SearchContentToolService } from './search-content.tool';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import type { RetrievedChunk } from '../retrieval/retrieval.types';

interface RetrieverMock {
  retrieve: jest.Mock;
}

/** A RetrievedChunk with the FULL Phase 4 metadata set (incl. the dropped fields). */
function chunk(
  id: string,
  text: string,
  episodeId: string,
  title: string,
  guestName = '',
): RetrievedChunk {
  return {
    id,
    document: text,
    score: 0.0163,
    chunkIndex: 7,
    metadata: {
      chunk_id: id,
      episode_id: episodeId,
      title,
      guest_name: guestName,
      guest_affiliation: '',
      guest_role: '',
      date: '',
      chunk_index: 7,
      total_chunks: 120,
      duration_min: 60,
    },
  };
}

describe('SearchContentToolService', () => {
  let service: SearchContentToolService;
  let retriever: RetrieverMock;

  beforeEach(() => {
    retriever = { retrieve: jest.fn() };
    service = new SearchContentToolService(retriever);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // --------------------------------------------------------------------------
  // Output shaping — fields kept/dropped
  // --------------------------------------------------------------------------
  describe('output shaping', () => {
    it('keeps only text/title/episodeId (+ guestName), drops score/id/index/empty fields', async () => {
      retriever.retrieve.mockResolvedValue([
        chunk('269_chunk_306', 'Cronin on constructors...', '269', 'Lee Cronin', 'Lee Cronin'),
      ]);

      const { passages } = await service.execute({ query: 'constructors' });

      expect(passages).toEqual([
        {
          text: 'Cronin on constructors...',
          title: 'Lee Cronin',
          episodeId: '269',
          guestName: 'Lee Cronin',
        },
      ]);
      // explicit drop assertions
      const p = passages[0] as unknown as Record<string, unknown>;
      expect(p).not.toHaveProperty('score');
      expect(p).not.toHaveProperty('id');
      expect(p).not.toHaveProperty('chunkIndex');
      expect(p).not.toHaveProperty('metadata');
      expect(p).not.toHaveProperty('guest_affiliation');
      expect(p).not.toHaveProperty('date');
    });

    it('omits guestName when the metadata value is empty', async () => {
      retriever.retrieve.mockResolvedValue([chunk('1_chunk_0', 'text', '1', 'Life 3.0', '')]);

      const { passages } = await service.execute({ query: 'consciousness' });

      expect(passages[0]).toEqual({ text: 'text', title: 'Life 3.0', episodeId: '1' });
      expect(passages[0]).not.toHaveProperty('guestName');
    });

    it('preserves the retriever (neighbor-adjacency) order', async () => {
      retriever.retrieve.mockResolvedValue([
        chunk('a_chunk_1', 't1', '10', 'A'),
        chunk('a_chunk_2', 't2', '10', 'A'),
        chunk('b_chunk_5', 't3', '20', 'B'),
      ]);

      const { passages } = await service.execute({ query: 'q' });

      expect(passages.map((p) => p.text)).toEqual(['t1', 't2', 't3']);
    });

    it('returns full passage text (not truncated)', async () => {
      const long = 'x'.repeat(800);
      retriever.retrieve.mockResolvedValue([chunk('1_chunk_0', long, '1', 'T')]);

      const { passages } = await service.execute({ query: 'q' });

      expect(passages[0].text).toHaveLength(800);
    });

    it('empty retrieval → empty passages + empty context', async () => {
      retriever.retrieve.mockResolvedValue([]);

      const result = await service.execute({ query: 'nothing matches' });

      expect(result.passages).toEqual([]);
      expect(result.context).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // context string — mirrors QaChainService.formatContext ([Source N] blocks)
  // --------------------------------------------------------------------------
  describe('context formatting (mirrors QaChainService.formatContext)', () => {
    it('renders numbered [Source N] blocks joined by a blank line, with attribution', async () => {
      retriever.retrieve.mockResolvedValue([
        chunk('269_chunk_306', 'First passage.', '269', 'Lee Cronin', 'Lee Cronin'),
        chunk('1_chunk_0', 'Second passage.', '1', 'Life 3.0'),
      ]);

      const { context } = await service.execute({ query: 'q' });

      expect(context).toBe(
        '[Source 1] episode=269 title="Lee Cronin" guest="Lee Cronin"\nFirst passage.' +
          '\n\n' +
          '[Source 2] episode=1 title="Life 3.0"\nSecond passage.',
      );
    });
  });

  // --------------------------------------------------------------------------
  // top_k — default, clamp, passthrough
  // --------------------------------------------------------------------------
  describe('top_k handling', () => {
    beforeEach(() => retriever.retrieve.mockResolvedValue([]));

    it('defaults to 5 when omitted', async () => {
      await service.execute({ query: 'q' });
      expect(retriever.retrieve).toHaveBeenCalledWith('q', { topK: 5 });
    });

    it('passes a within-cap value through', async () => {
      await service.execute({ query: 'q', top_k: 3 });
      expect(retriever.retrieve).toHaveBeenCalledWith('q', { topK: 3 });
    });

    it('clamps a value above the cap to 10 (hybrid does not cap it)', async () => {
      await service.execute({ query: 'q', top_k: 50 });
      expect(retriever.retrieve).toHaveBeenCalledWith('q', { topK: 10 });
    });

    it('clamps exactly at the cap', async () => {
      await service.execute({ query: 'q', top_k: 10 });
      expect(retriever.retrieve).toHaveBeenCalledWith('q', { topK: 10 });
    });
  });

  // --------------------------------------------------------------------------
  // input validation — rejects before touching the retriever
  // --------------------------------------------------------------------------
  describe('input validation', () => {
    it('rejects an empty query (retriever not called)', async () => {
      await expect(service.execute({ query: '' })).rejects.toBeInstanceOf(
        InvalidToolInputException,
      );
      expect(retriever.retrieve).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only query', async () => {
      await expect(service.execute({ query: '   ' })).rejects.toBeInstanceOf(
        InvalidToolInputException,
      );
      expect(retriever.retrieve).not.toHaveBeenCalled();
    });

    it('trims the query before retrieval', async () => {
      retriever.retrieve.mockResolvedValue([]);
      await service.execute({ query: '  consciousness  ' });
      expect(retriever.retrieve).toHaveBeenCalledWith('consciousness', { topK: 5 });
    });

    it('rejects a non-integer top_k', async () => {
      await expect(service.execute({ query: 'q', top_k: 2.5 })).rejects.toBeInstanceOf(
        InvalidToolInputException,
      );
      expect(retriever.retrieve).not.toHaveBeenCalled();
    });
  });
});
