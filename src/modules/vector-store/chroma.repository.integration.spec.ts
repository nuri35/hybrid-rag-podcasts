/**
 * Integration test for ChromaRepository against a real Chroma container.
 *
 * STATUS: skipped by default — these tests require a running Chroma server.
 *
 * To enable:
 *   1. Start the local Chroma service:    docker compose up -d chroma
 *   2. Wait for the healthcheck to pass:  docker compose ps   →   chroma: healthy
 *   3. Open this file and change `describe.skip(...)` to `describe(...)`
 *   4. Run:                                npx jest chroma.repository.integration.spec.ts
 *   5. Re-add `.skip` before committing — CI does not provision a Chroma container.
 *
 * The test uses a deterministic test collection name and resets it before each run, so
 * it is safe to re-run repeatedly. It exercises the real HTTP path: heartbeat, collection
 * lifecycle, upsert in batches, similaritySearch round-trip, and count.
 */
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Document } from '@langchain/core/documents';
import { ChromaRepository } from './chroma.repository';

const TEST_COLLECTION = 'integration_test_podcasts';

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    CHROMA_URL: process.env.CHROMA_URL ?? 'http://localhost:8000',
    CHROMA_COLLECTION: TEST_COLLECTION,
    CHROMA_DISTANCE_METRIC: 'cosine',
    CHROMA_WRITE_BATCH_SIZE: 100,
    CHROMA_WRITE_CONCURRENCY: 2,
    CHROMA_WRITE_TIMEOUT_MS: 30_000,
    CHROMA_WRITE_MAX_RETRIES: 2,
    CHROMA_API_KEY: process.env.CHROMA_API_KEY,
    CHROMA_API_KEY_HEADER: process.env.CHROMA_API_KEY_HEADER ?? 'X-Chroma-Token',
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService;
}

describe.skip('ChromaRepository (integration — requires running Chroma)', () => {
  let repo: ChromaRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ChromaRepository, { provide: ConfigService, useValue: makeConfig() }],
    }).compile();
    repo = moduleRef.get(ChromaRepository);
    await repo.onModuleInit();
    await repo.resetCollection();
  }, 30_000);

  it('upserts and queries a small set end-to-end', async () => {
    const chunks = Array.from(
      { length: 3 },
      (_, i) =>
        new Document({
          pageContent: `Sample chunk ${i} about consciousness and AI`,
          metadata: {
            episode_id: 'ep_int_001',
            title: 'Integration Test',
            date: '2026-01-01',
            duration_min: 60,
            guest_name: 'Test Guest',
            guest_affiliation: 'Test Lab',
            guest_role: 'Researcher',
            chunk_id: `ep_int_001_chunk_${i}`,
            chunk_index: i,
            total_chunks: 3,
          },
        }),
    );
    const vectors = chunks.map((_, i) => Array.from({ length: 768 }, (_, j) => (i + j) / 1000));

    await repo.addDocuments(chunks, vectors);
    const count = await repo.count();
    expect(count).toBe(3);

    const results = await repo.similaritySearch(vectors[0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('ep_int_001_chunk_0');
  }, 30_000);
});
