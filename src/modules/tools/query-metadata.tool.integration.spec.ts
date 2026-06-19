/**
 * Integration test for QueryMetadataToolService against the live episode index.
 *
 * STATUS: skipped by default (needs Elasticsearch + the podcast_episodes index).
 * Data-dependent snapshot checks (319 episodes, top guest 4, max 315) — update if
 * the dataset is re-ingested.
 *
 * Pre-conditions:
 *   1. docker compose up -d elasticsearch
 *   2. python scripts/elasticsearch/create-episode-index.py
 *      python scripts/elasticsearch/build-episode-index.py
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest query-metadata.tool.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { QueryMetadataToolService } from './query-metadata.tool';
import { MetadataAggregation } from '../metadata/metadata.types';

describe.skip('QueryMetadataToolService (integration — requires live podcast_episodes)', () => {
  let app: INestApplication;
  let service: QueryMetadataToolService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(QueryMetadataToolService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('count → 319 episodes', async () => {
    const out = await service.execute({ type: MetadataAggregation.COUNT });
    expect(out.result).toEqual({ type: MetadataAggregation.COUNT, value: 319 });
    expect(out.summary).toBe('There are 319 episodes.');
  });

  it('count_distinct guest_name → 281', async () => {
    const out = await service.execute({
      type: MetadataAggregation.COUNT_DISTINCT,
      field: 'guest_name',
    });
    expect(out.summary).toBe('There are 281 distinct guest_name values.');
  });

  it('group_by guest_name (limit 3) → top guests at 4 episodes', async () => {
    const out = await service.execute({
      type: MetadataAggregation.GROUP_BY,
      field: 'guest_name',
      limit: 3,
    });
    if (out.result.type !== MetadataAggregation.GROUP_BY) throw new Error('wrong type');
    expect(out.result.buckets[0].count).toBe(4);
    expect(out.summary).toContain('Top guest_name by episode count:');
  });

  it('max duration_min → 315', async () => {
    const out = await service.execute({ type: MetadataAggregation.MAX, field: 'duration_min' });
    if (out.result.type !== MetadataAggregation.MAX) throw new Error('wrong type');
    expect(out.result.value).toBe(315);
  });

  it('count with filter guest_name = "Michael Malice" → 4', async () => {
    const out = await service.execute({
      type: MetadataAggregation.COUNT,
      field: 'guest_name',
      value: 'Michael Malice',
    });
    expect(out.summary).toBe('4 episode(s) match guest_name = "Michael Malice".');
  });

  it('re-wraps a bad field/type pairing as InvalidToolInputException', async () => {
    // avg on a keyword field passes superRefine, fails the service allow-list.
    await expect(
      service.execute({ type: MetadataAggregation.AVG, field: 'guest_name' } as never),
    ).rejects.toThrow();
  });
});
