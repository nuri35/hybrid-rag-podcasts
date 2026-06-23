/**
 * Integration test for ToolRouterService against LIVE Gemini (Phase 5.3.2).
 *
 * STATUS: skipped by default — needs GOOGLE_API_KEY + a real Gemini call, and
 * boots AppModule (ES/Chroma/Redis for the tool services' downstream deps).
 *
 * Sanity only: one content-style question should route through search_content and
 * come back with a non-empty grounded answer. Routing-accuracy evaluation over a
 * labeled set is Phase 5.5, not here.
 *
 * Pre-conditions:
 *   1. docker compose up -d   (elasticsearch + chroma + redis)
 *   2. The podcast_chunks index is ingested (Phase 4).
 *   3. GOOGLE_API_KEY set in .env
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest tool-router.service.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { ToolRouterService } from './tool-router.service';

describe.skip('ToolRouterService (integration — real Gemini routing)', () => {
  let app: INestApplication;
  let service: ToolRouterService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(ToolRouterService);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('routes a content question through search_content and answers', async () => {
    const result = await service.route('What did Lee Cronin say about constructor theory?');

    expect(result.toolUsed).toContain('search_content');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.latency).toBeGreaterThan(0);
  }, 60_000);

  it('routes "how many episodes?" through query_metadata (count, no filter)', async () => {
    const result = await service.route('How many episodes are there?');

    expect(result.toolUsed).toContain('query_metadata');
    expect(result.answer.length).toBeGreaterThan(0);
  }, 60_000);

  it('routes "how many distinct guests?" through query_metadata (count_distinct)', async () => {
    const result = await service.route('How many distinct guests are there?');

    expect(result.toolUsed).toContain('query_metadata');
    expect(result.answer.length).toBeGreaterThan(0);
  }, 60_000);

  it('answers a greeting directly with no tool', async () => {
    const result = await service.route('Hello, how are you?');

    expect(result.toolUsed).toEqual([]);
    expect(result.answer.length).toBeGreaterThan(0);
  }, 60_000);

  it('runs a parallel round when a question needs content AND an exact fact', async () => {
    const result = await service.route(
      'How many episodes are there, and what do guests say about consciousness?',
    );

    // ideally both tools fire in one round; assert the metadata + content split
    expect(result.toolUsed).toContain('query_metadata');
    expect(result.toolUsed).toContain('search_content');
    expect(result.answer.length).toBeGreaterThan(0);
  }, 60_000);
});
