/**
 * Integration test for QaChainService against live infrastructure.
 *
 * STATUS: skipped by default. Re-enable manually when verifying end-to-end
 * QA against a populated Chroma collection + a real Gemini chat model.
 *
 * Pre-conditions:
 *   1. Chroma running:        docker compose up -d chroma
 *   2. Collection populated:  npm run cli -- ingest --csv data/podcasts.csv --reset
 *                             (≈53k vectors, ≈50 min on Tier 1)
 *   3. .env has a valid GOOGLE_API_KEY with both embedding + chat quota
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest qa-chain.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing — CI does not provision Chroma + Gemini.
 *
 * Each test spends 1 Gemini embed call + at most 1 LLM call. Total ≈3 embeds,
 * ≈2–3 chat calls. Gemini-flash latency dominates (~1–3 s per LLM call), so
 * timeouts are wider than retrieval-only tests.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { QaChainService } from './qa-chain.service';

describe.skip('QaChainService (integration — requires Chroma + GOOGLE_API_KEY)', () => {
  let app: INestApplication;
  let qaChain: QaChainService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    qaChain = moduleRef.get(QaChainService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns an answer with 5 sources for "What is consciousness?" (default topK)', async () => {
    const result = await qaChain.ask('What is consciousness?');

    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.sources).toHaveLength(5);
    result.sources.forEach((source) => {
      expect(typeof source.chunkId).toBe('string');
      expect(source.chunkId.length).toBeGreaterThan(0);
      expect(typeof source.score).toBe('number');
      expect(typeof source.excerpt).toBe('string');
      expect(source.excerpt.length).toBeGreaterThan(0);
      expect(source.metadata).toHaveProperty('episode_id');
    });

    console.log(
      `[consciousness] answer_length=${result.answer.length} sources=${result.sources.length}\n` +
        `  preview: ${result.answer.substring(0, 200)}${result.answer.length > 200 ? '…' : ''}`,
    );
  }, 60_000);

  it('respects an explicit topK option (topK=3 → 3 sources)', async () => {
    const result = await qaChain.ask('AI ethics', { topK: 3 });

    expect(result.sources).toHaveLength(3);
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);

    console.log(
      `[ai-ethics topK=3] sources=${result.sources.length} ` +
        `score_range=[${result.sources[result.sources.length - 1]?.score.toFixed(4)}, ` +
        `${result.sources[0]?.score.toFixed(4)}]`,
    );
  }, 60_000);

  it('returns a no-info-style answer for off-topic gibberish (soft assertion)', async () => {
    const result = await qaChain.ask('qzplkx vmwthn brxfvq plumberfizzwidget tachyonic xyzzyspoon');

    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);

    const lowered = result.answer.toLowerCase();
    const noInfoMarkers = [
      "don't have enough information",
      'do not have enough information',
      'no information',
      'not in the context',
      'cannot answer',
      "can't answer",
    ];
    const matched = noInfoMarkers.some((marker) => lowered.includes(marker));

    console.log(
      `[gibberish] sources=${result.sources.length} matched_no_info=${matched}\n` +
        `  preview: ${result.answer.substring(0, 200)}${result.answer.length > 200 ? '…' : ''}`,
    );
    // Soft assertion — log only. Phase 1.8 golden-questions harness will do
    // strict validation. A semantic search over 53k vectors will almost always
    // surface SOMETHING, so the LLM, guided by the prompt's refusal clause,
    // must do the rejection. We don't fail the test on a single miss.
    if (!matched) {
      console.warn(
        `⚠️ off-topic answer did not contain a no-info marker; ` +
          `review prompt template or model behavior`,
      );
    }
  }, 60_000);
});
