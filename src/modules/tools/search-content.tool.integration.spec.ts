/**
 * Integration test for SearchContentToolService against the live retrieval path.
 *
 * STATUS: skipped by default (needs Chroma + Elasticsearch + Gemini embeddings).
 * It exercises the REAL `RETRIEVER` token (hybrid: vector + BM25 + RRF + ±1
 * expansion), so it spends 1 Gemini embedding call per query.
 *
 * Pre-conditions:
 *   1. docker compose up -d chroma elasticsearch redis
 *   2. Chroma ingested + podcast_chunks populated (Phase 1 + 4.1)
 *   3. GOOGLE_API_KEY in .env (embeddings)
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest search-content.tool.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { SearchContentToolService } from './search-content.tool';

describe.skip('SearchContentToolService (integration — requires live retrieval)', () => {
  let app: INestApplication;
  let service: SearchContentToolService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(SearchContentToolService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns shaped passages for a content query', async () => {
    const { passages, context } = await service.execute({
      query: 'What does Lee Cronin mean by constructors and abstractors?',
    });

    expect(passages.length).toBeGreaterThan(0);
    passages.forEach((p) => {
      expect(typeof p.text).toBe('string');
      expect(p.text.length).toBeGreaterThan(0);
      expect(typeof p.title).toBe('string');
      expect(typeof p.episodeId).toBe('string');
      // dropped fields must NOT leak
      expect(p).not.toHaveProperty('score');
      expect(p).not.toHaveProperty('id');
      expect(p).not.toHaveProperty('metadata');
    });
    // context mirrors the [Source N] block convention
    expect(context).toContain('[Source 1] episode=');
  });

  it('respects the top_k cap (≤ MAX_EXPANDED_CHUNKS after expansion)', async () => {
    const { passages } = await service.execute({ query: 'consciousness', top_k: 10 });
    expect(passages.length).toBeLessThanOrEqual(12);
  });
});
