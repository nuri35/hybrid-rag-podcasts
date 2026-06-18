import { Logger } from '@nestjs/common';
import { MetadataQueryService } from './metadata-query.service';
import { METADATA_INDEX, METADATA_QUERY_TIMEOUT_MS } from './metadata.constants';
import { InvalidMetadataQueryException, MetadataQueryFailedException } from './exceptions';
import { MetadataAggregation } from './metadata.types';

interface ClientMock {
  search: jest.Mock;
}

const OPTS = { requestTimeout: METADATA_QUERY_TIMEOUT_MS };

describe('MetadataQueryService', () => {
  let service: MetadataQueryService;
  let client: ClientMock;

  beforeEach(() => {
    client = { search: jest.fn() };
    service = new MetadataQueryService(client as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ----------------------------------------------------------------------------
  // 1. Query construction — the right ES body per aggregation type
  // ----------------------------------------------------------------------------
  describe('query construction', () => {
    it('count (no filter) → size:0, track_total_hits, match_all', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 319 } } });
      await service.aggregate({ type: MetadataAggregation.COUNT });
      expect(client.search).toHaveBeenCalledWith(
        { index: METADATA_INDEX, size: 0, track_total_hits: true, query: { match_all: {} } },
        OPTS,
      );
    });

    it('count (with filter) → bool filter term query', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 4 } } });
      await service.aggregate({
        type: MetadataAggregation.COUNT,
        filter: { field: 'guest_name', value: 'Michael Malice' },
      });
      expect(client.search).toHaveBeenCalledWith(
        {
          index: METADATA_INDEX,
          size: 0,
          track_total_hits: true,
          query: { bool: { filter: [{ term: { guest_name: 'Michael Malice' } }] } },
        },
        OPTS,
      );
    });

    it('count_distinct → cardinality agg', async () => {
      client.search.mockResolvedValue({ aggregations: { distinct: { value: 281 } } });
      await service.aggregate({
        type: MetadataAggregation.COUNT_DISTINCT,
        field: 'guest_name',
      });
      expect(client.search).toHaveBeenCalledWith(
        {
          index: METADATA_INDEX,
          size: 0,
          aggs: { distinct: { cardinality: { field: 'guest_name' } } },
        },
        OPTS,
      );
    });

    it('filter → size:limit, _source projection, bool filter term', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
      await service.aggregate({
        type: MetadataAggregation.FILTER,
        field: 'title',
        value: 'Cardano',
        limit: 25,
      });
      expect(client.search).toHaveBeenCalledWith(
        {
          index: METADATA_INDEX,
          size: 25,
          track_total_hits: true,
          _source: ['episode_id', 'title', 'guest_name'],
          query: { bool: { filter: [{ term: { title: 'Cardano' } }] } },
        },
        OPTS,
      );
    });

    it('min → sort asc size:1; max → sort desc size:1', async () => {
      client.search.mockResolvedValue({ hits: { hits: [] } });
      await service.aggregate({ type: MetadataAggregation.MIN, field: 'duration_min' });
      expect(client.search).toHaveBeenCalledWith(
        {
          index: METADATA_INDEX,
          size: 1,
          sort: [{ duration_min: 'asc' }],
          _source: ['episode_id', 'title', 'guest_name', 'duration_min'],
        },
        OPTS,
      );
      await service.aggregate({ type: MetadataAggregation.MAX, field: 'duration_min' });
      expect(client.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ size: 1, sort: [{ duration_min: 'desc' }] }),
        OPTS,
      );
    });

    it('avg → avg agg', async () => {
      client.search.mockResolvedValue({ aggregations: { average: { value: 59.74 } } });
      await service.aggregate({ type: MetadataAggregation.AVG, field: 'duration_min' });
      expect(client.search).toHaveBeenCalledWith(
        { index: METADATA_INDEX, size: 0, aggs: { average: { avg: { field: 'duration_min' } } } },
        OPTS,
      );
    });

    it('group_by → terms agg with size', async () => {
      client.search.mockResolvedValue({ aggregations: { groups: { buckets: [] } } });
      await service.aggregate({ type: MetadataAggregation.GROUP_BY, field: 'guest_name', size: 3 });
      expect(client.search).toHaveBeenCalledWith(
        {
          index: METADATA_INDEX,
          size: 0,
          aggs: { groups: { terms: { field: 'guest_name', size: 3 } } },
        },
        OPTS,
      );
    });
  });

  // ----------------------------------------------------------------------------
  // 2. Result mapping — typed result from a canned ES response
  // ----------------------------------------------------------------------------
  describe('result mapping', () => {
    it('count maps hits.total.value (and echoes the filter)', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 4 } } });
      const r = await service.aggregate({
        type: MetadataAggregation.COUNT,
        filter: { field: 'guest_name', value: 'Michael Malice' },
      });
      expect(r).toEqual({
        type: MetadataAggregation.COUNT,
        value: 4,
        filter: { field: 'guest_name', value: 'Michael Malice' },
      });
    });

    it('count normalizes a numeric hits.total', async () => {
      client.search.mockResolvedValue({ hits: { total: 319 } });
      const r = await service.aggregate({ type: MetadataAggregation.COUNT });
      expect(r).toEqual({ type: MetadataAggregation.COUNT, value: 319 });
    });

    it('count_distinct maps cardinality value', async () => {
      client.search.mockResolvedValue({ aggregations: { distinct: { value: 281 } } });
      const r = await service.aggregate({
        type: MetadataAggregation.COUNT_DISTINCT,
        field: 'title',
      });
      expect(r).toEqual({ type: MetadataAggregation.COUNT_DISTINCT, field: 'title', value: 281 });
    });

    it('filter maps count + episode refs', async () => {
      client.search.mockResolvedValue({
        hits: {
          total: { value: 2 },
          hits: [
            {
              _id: '1',
              _source: { episode_id: '1', title: 'Life 3.0', guest_name: 'Max Tegmark' },
            },
            { _id: '99', _source: { episode_id: '99', title: 'X', guest_name: 'Max Tegmark' } },
          ],
        },
      });
      const r = await service.aggregate({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'Max Tegmark',
      });
      expect(r).toEqual({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'Max Tegmark',
        count: 2,
        episodes: [
          { episodeId: '1', title: 'Life 3.0', guestName: 'Max Tegmark' },
          { episodeId: '99', title: 'X', guestName: 'Max Tegmark' },
        ],
      });
    });

    it('max maps value + the holding episode', async () => {
      client.search.mockResolvedValue({
        hits: {
          hits: [
            {
              _id: '7',
              _source: { episode_id: '7', title: 'Long one', guest_name: 'G', duration_min: 315 },
            },
          ],
        },
      });
      const r = await service.aggregate({ type: MetadataAggregation.MAX, field: 'duration_min' });
      expect(r).toEqual({
        type: MetadataAggregation.MAX,
        field: 'duration_min',
        value: 315,
        episode: { episodeId: '7', title: 'Long one', guestName: 'G' },
      });
    });

    it('min on an empty index → value null, episode null', async () => {
      client.search.mockResolvedValue({ hits: { hits: [] } });
      const r = await service.aggregate({ type: MetadataAggregation.MIN, field: 'duration_min' });
      expect(r).toEqual({
        type: MetadataAggregation.MIN,
        field: 'duration_min',
        value: null,
        episode: null,
      });
    });

    it('avg maps the average value', async () => {
      client.search.mockResolvedValue({ aggregations: { average: { value: 59.7492 } } });
      const r = await service.aggregate({ type: MetadataAggregation.AVG, field: 'duration_min' });
      expect(r).toEqual({ type: MetadataAggregation.AVG, field: 'duration_min', value: 59.7492 });
    });

    it('group_by maps buckets key→count (episode counts)', async () => {
      client.search.mockResolvedValue({
        aggregations: {
          groups: {
            buckets: [
              { key: 'Eric Weinstein', doc_count: 4 },
              { key: 'Manolis Kellis', doc_count: 4 },
            ],
          },
        },
      });
      const r = await service.aggregate({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
      });
      expect(r).toEqual({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
        buckets: [
          { key: 'Eric Weinstein', count: 4 },
          { key: 'Manolis Kellis', count: 4 },
        ],
      });
    });
  });

  // ----------------------------------------------------------------------------
  // 3. Validation (trust boundary) — InvalidMetadataQueryException, ES untouched
  // ----------------------------------------------------------------------------
  describe('validation', () => {
    const expectInvalid = async (req: unknown) => {
      await expect(service.aggregate(req as never)).rejects.toBeInstanceOf(
        InvalidMetadataQueryException,
      );
      expect(client.search).not.toHaveBeenCalled();
    };

    it('rejects an unknown aggregation type', () =>
      expectInvalid({ type: 'median', field: 'duration_min' }));

    it('rejects avg/min/max on a keyword field', async () => {
      await expectInvalid({ type: MetadataAggregation.AVG, field: 'guest_name' });
    });

    it('rejects count_distinct / group_by / filter on a numeric field', async () => {
      await expectInvalid({ type: MetadataAggregation.GROUP_BY, field: 'duration_min' });
    });

    it('rejects an excluded/empty field (date) and an unknown field (text)', async () => {
      await expectInvalid({ type: MetadataAggregation.COUNT_DISTINCT, field: 'date' });
    });

    it('rejects an unknown keyword field (text)', () =>
      expectInvalid({ type: MetadataAggregation.GROUP_BY, field: 'text' }));

    it('rejects an empty filter value', () =>
      expectInvalid({ type: MetadataAggregation.FILTER, field: 'guest_name', value: '   ' }));

    it('rejects a non-integer / non-positive limit', () =>
      expectInvalid({ type: MetadataAggregation.FILTER, field: 'title', value: 'X', limit: 0 }));
  });

  // ----------------------------------------------------------------------------
  // 4. Fail-loud — ES errors wrap; validation errors do NOT wrap
  // ----------------------------------------------------------------------------
  describe('fail-loud', () => {
    it('wraps an ES error in MetadataQueryFailedException (never a degraded value)', async () => {
      client.search.mockRejectedValue(new Error('cluster_block_exception'));
      await expect(service.aggregate({ type: MetadataAggregation.COUNT })).rejects.toBeInstanceOf(
        MetadataQueryFailedException,
      );
    });

    it('wraps a malformed response (missing aggregation)', async () => {
      client.search.mockResolvedValue({ aggregations: {} });
      await expect(
        service.aggregate({ type: MetadataAggregation.AVG, field: 'duration_min' }),
      ).rejects.toBeInstanceOf(MetadataQueryFailedException);
    });

    it('does NOT wrap a validation error as a query failure', async () => {
      await expect(
        service.aggregate({ type: MetadataAggregation.AVG, field: 'guest_name' } as never),
      ).rejects.toBeInstanceOf(InvalidMetadataQueryException);
    });
  });

  // ----------------------------------------------------------------------------
  // 5. Defaults & caps
  // ----------------------------------------------------------------------------
  describe('defaults & caps', () => {
    it('filter defaults to DEFAULT_FILTER_LIMIT (50) when no limit', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
      await service.aggregate({ type: MetadataAggregation.FILTER, field: 'title', value: 'X' });
      expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ size: 50 }), OPTS);
    });

    it('filter caps limit at MAX_FILTER_LIMIT (200)', async () => {
      client.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
      await service.aggregate({
        type: MetadataAggregation.FILTER,
        field: 'title',
        value: 'X',
        limit: 9999,
      });
      expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ size: 200 }), OPTS);
    });

    it('group_by defaults to DEFAULT_GROUP_BY_SIZE (10) and caps at MAX (100)', async () => {
      client.search.mockResolvedValue({ aggregations: { groups: { buckets: [] } } });
      await service.aggregate({ type: MetadataAggregation.GROUP_BY, field: 'guest_name' });
      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({ aggs: { groups: { terms: { field: 'guest_name', size: 10 } } } }),
        OPTS,
      );
      await service.aggregate({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
        size: 9999,
      });
      expect(client.search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          aggs: { groups: { terms: { field: 'guest_name', size: 100 } } },
        }),
        OPTS,
      );
    });
  });
});
