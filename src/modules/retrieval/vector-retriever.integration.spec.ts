/**
 * Integration test for VectorRetrieverService against live infrastructure.
 *
 * STATUS: skipped by default. Re-enable manually when verifying end-to-end
 * retrieval against a populated Chroma collection.
 *
 * Pre-conditions:
 *   1. Chroma running:        docker compose up -d chroma
 *   2. Collection populated:  npm run cli -- ingest --csv data/podcasts.csv --reset
 *                             (≈53k vectors, ≈50 min on Tier 1)
 *   3. .env has a valid GOOGLE_API_KEY with embedding quota
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest vector-retriever.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing — CI does not provision Chroma + Gemini.
 *
 * Each test spends 1 Gemini embed call (RETRIEVAL_QUERY). Total ≈4 calls.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { VectorRetrieverService } from './vector-retriever.service';

describe.skip('VectorRetrieverService (integration — requires Chroma + GOOGLE_API_KEY)', () => {
  let app: INestApplication;
  let retriever: VectorRetrieverService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    retriever = moduleRef.get(VectorRetrieverService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('retrieves 5 relevant chunks for "What is consciousness?"', async () => {
    const chunks = await retriever.retrieve('What is consciousness?', { topK: 5 });

    expect(chunks).toHaveLength(5);
    chunks.forEach((chunk) => {
      expect(typeof chunk.id).toBe('string');
      expect(chunk.id.length).toBeGreaterThan(0);
      expect(chunk.score).toBeGreaterThanOrEqual(0);
      expect(chunk.score).toBeLessThanOrEqual(1);
      expect(typeof chunk.document).toBe('string');
      expect(chunk.document.length).toBeGreaterThan(0);
      expect(chunk.metadata).toHaveProperty('episode_id');
    });
    // Visual inspection aid — scores should be descending and meaningfully > 0.
    // eslint-disable-next-line no-console
    console.log(
      `Top 5 (consciousness): ${chunks.map((c) => `${c.id}=${c.score.toFixed(4)}`).join(', ')}`,
    );
  }, 30_000);

  it('applies score threshold filter when provided', async () => {
    const threshold = 0.5;
    const chunks = await retriever.retrieve('artificial intelligence', {
      topK: 10,
      scoreThreshold: threshold,
    });

    expect(chunks.length).toBeLessThanOrEqual(10);
    chunks.forEach((chunk) => {
      expect(chunk.score).toBeGreaterThanOrEqual(threshold);
    });
    // eslint-disable-next-line no-console
    console.log(
      `AI w/ threshold=${threshold}: kept ${chunks.length}/10, ` +
        `score range=[${chunks[chunks.length - 1]?.score.toFixed(4)}, ${chunks[0]?.score.toFixed(4)}]`,
    );
  }, 30_000);

  it('returns a result in under 1 second for a single query', async () => {
    const start = Date.now();
    const chunks = await retriever.retrieve('deep learning', { topK: 5 });
    const duration = Date.now() - start;

    expect(chunks.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`Latency (deep learning, topK=5): ${duration}ms`);
    expect(duration).toBeLessThan(1000);
  }, 30_000);

  it('top result is semantically relevant (soft assertion)', async () => {
    const chunks = await retriever.retrieve('How do neural networks learn?', { topK: 3 });

    expect(chunks.length).toBeGreaterThan(0);
    const topDoc = chunks[0].document.toLowerCase();
    const relevantKeywords = ['neural', 'network', 'learn', 'training', 'weight', 'gradient'];
    const matched = relevantKeywords.filter((kw) => topDoc.includes(kw));

    // eslint-disable-next-line no-console
    console.log(
      `Neural-net top match: id=${chunks[0].id}, score=${chunks[0].score.toFixed(4)}, ` +
        `keywords matched=[${matched.join(', ')}]`,
    );
    // Soft assertion — log only, do not fail the test on a single retrieval
    // miss. Phase 1.8 golden-questions harness will do strict validation.
    if (matched.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `⚠️ no neural-net keyword found in top doc; review whether the dataset / cleaning is healthy`,
      );
    }
  }, 30_000);
});
