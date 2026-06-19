import { Logger } from '@nestjs/common';
import { QueryMetadataToolService } from './query-metadata.tool';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import {
  InvalidMetadataQueryException,
  MetadataQueryFailedException,
} from '../metadata/exceptions';
import { MetadataAggregation } from '../metadata/metadata.types';
import { KEYWORD_FIELDS, NUMERIC_FIELDS } from '../metadata/metadata.constants';
import { QUERY_METADATA_FIELDS } from './tools.constants';

interface MetadataMock {
  aggregate: jest.Mock;
}

describe('query_metadata field enum drift guard', () => {
  it('QUERY_METADATA_FIELDS exactly covers the service keyword + numeric allow-lists', () => {
    expect(new Set(QUERY_METADATA_FIELDS)).toEqual(new Set([...KEYWORD_FIELDS, ...NUMERIC_FIELDS]));
  });
});

describe('QueryMetadataToolService', () => {
  let service: QueryMetadataToolService;
  let metadata: MetadataMock;

  beforeEach(() => {
    metadata = { aggregate: jest.fn() };
    service = new QueryMetadataToolService(metadata as never);
    // default valid result so summarize() runs in mapping tests
    metadata.aggregate.mockResolvedValue({ type: MetadataAggregation.COUNT, value: 1 });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // --------------------------------------------------------------------------
  // 1. flat → strict-union mapping
  // --------------------------------------------------------------------------
  describe('flat → request mapping', () => {
    it('count (no filter) → { type: count }', async () => {
      await service.execute({ type: MetadataAggregation.COUNT });
      expect(metadata.aggregate).toHaveBeenCalledWith({ type: MetadataAggregation.COUNT });
    });

    it('count (field + value) → nested filter object', async () => {
      await service.execute({
        type: MetadataAggregation.COUNT,
        field: 'guest_name',
        value: 'Michael Malice',
      });
      expect(metadata.aggregate).toHaveBeenCalledWith({
        type: MetadataAggregation.COUNT,
        filter: { field: 'guest_name', value: 'Michael Malice' },
      });
    });

    it('count_distinct → { type, field }', async () => {
      await service.execute({ type: MetadataAggregation.COUNT_DISTINCT, field: 'title' });
      expect(metadata.aggregate).toHaveBeenCalledWith({
        type: MetadataAggregation.COUNT_DISTINCT,
        field: 'title',
      });
    });

    it('filter → { type, field, value } (+ limit when given)', async () => {
      await service.execute({ type: MetadataAggregation.FILTER, field: 'guest_name', value: 'X' });
      expect(metadata.aggregate).toHaveBeenCalledWith({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'X',
      });

      await service.execute({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'X',
        limit: 25,
      });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'X',
        limit: 25,
      });
    });

    it('min / max / avg → { type, field }', async () => {
      await service.execute({ type: MetadataAggregation.MIN, field: 'duration_min' });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.MIN,
        field: 'duration_min',
      });
      await service.execute({ type: MetadataAggregation.MAX, field: 'duration_min' });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.MAX,
        field: 'duration_min',
      });
      await service.execute({ type: MetadataAggregation.AVG, field: 'duration_min' });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.AVG,
        field: 'duration_min',
      });
    });

    it('group_by → { type, field } with limit mapped to size', async () => {
      await service.execute({ type: MetadataAggregation.GROUP_BY, field: 'guest_name' });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
      });
      await service.execute({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
        limit: 3,
      });
      expect(metadata.aggregate).toHaveBeenLastCalledWith({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
        size: 3,
      });
    });
  });

  // --------------------------------------------------------------------------
  // 2. superRefine validation — InvalidToolInputException, aggregate untouched
  // --------------------------------------------------------------------------
  describe('input validation (superRefine)', () => {
    const expectInvalid = async (input: unknown) => {
      await expect(service.execute(input as never)).rejects.toBeInstanceOf(
        InvalidToolInputException,
      );
      expect(metadata.aggregate).not.toHaveBeenCalled();
    };

    it('count_distinct without field', () =>
      expectInvalid({ type: MetadataAggregation.COUNT_DISTINCT }));
    it('group_by without field', () => expectInvalid({ type: MetadataAggregation.GROUP_BY }));
    it('min without field', () => expectInvalid({ type: MetadataAggregation.MIN }));
    it('filter without value', () =>
      expectInvalid({ type: MetadataAggregation.FILTER, field: 'guest_name' }));
    it('count with field but no value (all-or-nothing)', () =>
      expectInvalid({ type: MetadataAggregation.COUNT, field: 'guest_name' }));
    it('unknown aggregation type', () => expectInvalid({ type: 'median', field: 'duration_min' }));
    it('field outside the enum (text)', () =>
      expectInvalid({ type: MetadataAggregation.COUNT_DISTINCT, field: 'text' }));
  });

  // --------------------------------------------------------------------------
  // 3. exception policy
  // --------------------------------------------------------------------------
  describe('exception policy', () => {
    it('re-wraps InvalidMetadataQueryException → InvalidToolInputException', async () => {
      metadata.aggregate.mockRejectedValue(
        new InvalidMetadataQueryException('field "guest_name" is not numeric'),
      );
      await expect(
        // avg on a keyword field passes superRefine but fails the service allow-list
        service.execute({ type: MetadataAggregation.AVG, field: 'guest_name' } as never),
      ).rejects.toBeInstanceOf(InvalidToolInputException);
    });

    it('propagates MetadataQueryFailedException untouched (fail-loud)', async () => {
      metadata.aggregate.mockRejectedValue(new MetadataQueryFailedException('cluster down'));
      await expect(service.execute({ type: MetadataAggregation.COUNT })).rejects.toBeInstanceOf(
        MetadataQueryFailedException,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. output shaping — { result, summary }
  // --------------------------------------------------------------------------
  describe('output shaping (summary)', () => {
    const run = async (result: unknown) => {
      metadata.aggregate.mockResolvedValue(result);
      return service.execute({ type: MetadataAggregation.COUNT });
    };

    it('passes the structured result through unchanged', async () => {
      const result = { type: MetadataAggregation.COUNT, value: 319 };
      const out = await run(result);
      expect(out.result).toEqual(result);
    });

    it('count → "There are N episodes."', async () => {
      const out = await run({ type: MetadataAggregation.COUNT, value: 319 });
      expect(out.summary).toBe('There are 319 episodes.');
    });

    it('count with filter → match phrasing', async () => {
      const out = await run({
        type: MetadataAggregation.COUNT,
        value: 4,
        filter: { field: 'guest_name', value: 'Michael Malice' },
      });
      expect(out.summary).toBe('4 episode(s) match guest_name = "Michael Malice".');
    });

    it('count_distinct → distinct phrasing', async () => {
      const out = await run({
        type: MetadataAggregation.COUNT_DISTINCT,
        field: 'guest_name',
        value: 281,
      });
      expect(out.summary).toBe('There are 281 distinct guest_name values.');
    });

    it('filter → count + listed episodes (with … when truncated)', async () => {
      const out = await run({
        type: MetadataAggregation.FILTER,
        field: 'guest_name',
        value: 'Lex',
        count: 3,
        episodes: [
          { episodeId: '1', title: 'A', guestName: 'Lex' },
          { episodeId: '2', title: 'B', guestName: 'Lex' },
        ],
      });
      expect(out.summary).toBe('3 episode(s) match guest_name = "Lex": "A" (ep 1), "B" (ep 2) …');
    });

    it('filter with zero matches', async () => {
      const out = await run({
        type: MetadataAggregation.FILTER,
        field: 'title',
        value: 'Nope',
        count: 0,
        episodes: [],
      });
      expect(out.summary).toBe('No episodes match title = "Nope".');
    });

    it('max → value + holding episode', async () => {
      const out = await run({
        type: MetadataAggregation.MAX,
        field: 'duration_min',
        value: 315,
        episode: { episodeId: '7', title: 'Long', guestName: 'G' },
      });
      expect(out.summary).toBe('The maximum duration_min is 315 (episode "Long", ep 7).');
    });

    it('avg → rounded to 2 decimals', async () => {
      const out = await run({
        type: MetadataAggregation.AVG,
        field: 'duration_min',
        value: 59.7492,
      });
      expect(out.summary).toBe('The average duration_min is 59.75.');
    });

    it('min/avg with null value → no-data phrasing', async () => {
      const out = await run({ type: MetadataAggregation.AVG, field: 'duration_min', value: null });
      expect(out.summary).toBe('No duration_min data available.');
    });

    it('group_by → top buckets', async () => {
      const out = await run({
        type: MetadataAggregation.GROUP_BY,
        field: 'guest_name',
        buckets: [
          { key: 'Eric Weinstein', count: 4 },
          { key: 'Manolis Kellis', count: 4 },
        ],
      });
      expect(out.summary).toBe(
        'Top guest_name by episode count: Eric Weinstein (4), Manolis Kellis (4).',
      );
    });
  });
});
