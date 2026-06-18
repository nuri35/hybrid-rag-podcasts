/**
 * Integration test for MetadataQueryService against a live cluster.
 *
 * STATUS: skipped by default (CI does not provision Elasticsearch). The
 * assertions are DATA-DEPENDENT SNAPSHOT checks — they reflect the current
 * dataset (319 episodes, 281 distinct guests, duration 33–315). If the dataset
 * is re-ingested, update these snapshots.
 *
 * Pre-conditions:
 *   1. ES running:            docker compose up -d elasticsearch
 *   2. Chunk index populated: python scripts/elasticsearch/ingest-chunks.py
 *   3. Episode index built:   python scripts/elasticsearch/create-episode-index.py
 *                             python scripts/elasticsearch/build-episode-index.py
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest metadata-query.service.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing.
 *
 * No API quota is spent — these are local ES aggregations.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { MetadataQueryService } from './metadata-query.service';
import { MetadataAggregation } from './metadata.types';

describe.skip('MetadataQueryService (integration — requires live podcast_episodes)', () => {
  let app: INestApplication;
  let service: MetadataQueryService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(MetadataQueryService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('count → 319 episodes', async () => {
    const r = await service.aggregate({ type: MetadataAggregation.COUNT });
    expect(r).toEqual({ type: MetadataAggregation.COUNT, value: 319 });
  });

  it('count_distinct guest_name → 281; title → 317', async () => {
    const guests = await service.aggregate({
      type: MetadataAggregation.COUNT_DISTINCT,
      field: 'guest_name',
    });
    const titles = await service.aggregate({
      type: MetadataAggregation.COUNT_DISTINCT,
      field: 'title',
    });
    expect(guests).toEqual({
      type: MetadataAggregation.COUNT_DISTINCT,
      field: 'guest_name',
      value: 281,
    });
    expect(titles).toEqual({
      type: MetadataAggregation.COUNT_DISTINCT,
      field: 'title',
      value: 317,
    });
  });

  it('group_by guest_name → top guests appear in 4 episodes each (episode grain)', async () => {
    const r = await service.aggregate({
      type: MetadataAggregation.GROUP_BY,
      field: 'guest_name',
      size: 3,
    });
    if (r.type !== MetadataAggregation.GROUP_BY) throw new Error('wrong result type');
    expect(r.buckets).toHaveLength(3);
    expect(r.buckets[0].count).toBe(4);
    expect(r.buckets.map((b) => b.key)).toEqual(
      expect.arrayContaining(['Eric Weinstein', 'Manolis Kellis', 'Michael Malice']),
    );
  });

  it('max / min duration_min → 315 / 33, with a holding episode', async () => {
    const max = await service.aggregate({ type: MetadataAggregation.MAX, field: 'duration_min' });
    const min = await service.aggregate({ type: MetadataAggregation.MIN, field: 'duration_min' });
    if (max.type !== MetadataAggregation.MAX || min.type !== MetadataAggregation.MIN) {
      throw new Error('wrong result type');
    }
    expect(max.value).toBe(315);
    expect(min.value).toBe(33);
    expect(max.episode?.episodeId).toBeTruthy();
    expect(min.episode?.episodeId).toBeTruthy();
  });

  it('avg duration_min → ~59.75', async () => {
    const r = await service.aggregate({ type: MetadataAggregation.AVG, field: 'duration_min' });
    if (r.type !== MetadataAggregation.AVG) throw new Error('wrong result type');
    expect(r.value).toBeCloseTo(59.7492, 2);
  });

  it('filter guest_name = "Michael Malice" → 4 episodes', async () => {
    const r = await service.aggregate({
      type: MetadataAggregation.FILTER,
      field: 'guest_name',
      value: 'Michael Malice',
    });
    if (r.type !== MetadataAggregation.FILTER) throw new Error('wrong result type');
    expect(r.count).toBe(4);
    expect(r.episodes).toHaveLength(4);
    r.episodes.forEach((e) => expect(e.guestName).toBe('Michael Malice'));
  });

  it('count with filter guest_name = "Michael Malice" → 4', async () => {
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
});
