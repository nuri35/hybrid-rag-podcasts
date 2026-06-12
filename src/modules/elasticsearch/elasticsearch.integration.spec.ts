/**
 * Integration test for ElasticsearchService against a live cluster.
 *
 * STATUS: skipped by default. Re-enable manually when verifying keyword
 * retrieval against the populated `podcast_chunks` index.
 *
 * Pre-conditions:
 *   1. ES running:        docker compose up -d elasticsearch
 *   2. Index populated:   python scripts/elasticsearch/ingest-chunks.py
 *                         (53,427 chunks; ~15 s)
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest elasticsearch.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing — CI does not provision Elasticsearch.
 *
 * No API quota is spent (BM25 is local; no embeddings) — these are cheap.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { ElasticsearchService } from './elasticsearch.service';

describe.skip('ElasticsearchService (integration — requires live Elasticsearch)', () => {
  let app: INestApplication;
  let service: ElasticsearchService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(ElasticsearchService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('ground-truth regression: "constructors abstractors" surfaces 269_chunk_306', async () => {
    const hits = await service.search('constructors abstractors', 5);

    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('269_chunk_306');

    // Every hit is the symmetric RetrievedChunk shape.
    hits.forEach((h) => {
      expect(typeof h.id).toBe('string');
      expect(typeof h.document).toBe('string');
      expect(h.document.length).toBeGreaterThan(0);
      expect(typeof h.score).toBe('number');
      expect(h.metadata).toHaveProperty('episode_id');
      expect(h.metadata).not.toHaveProperty('text');
    });

    console.log(
      `constructors abstractors → ${hits.map((h) => `${h.id}=${h.score.toFixed(2)}`).join(', ')}`,
    );
  }, 15_000);

  it('returns at least one result for "Turing machine biology"', async () => {
    const hits = await service.search('Turing machine biology', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    console.log(`Turing machine biology → top=${hits[0]?.id} score=${hits[0]?.score.toFixed(2)}`);
  }, 15_000);

  it('isHealthy() is true against the running cluster', async () => {
    await expect(service.isHealthy()).resolves.toBe(true);
  }, 15_000);
});
