/**
 * Integration test for the Phase 5.3.1 tool factory against LIVE Gemini.
 *
 * STATUS: skipped by default (needs GOOGLE_API_KEY + a real Gemini call; also
 * boots AppModule which needs ES/Chroma/Redis for the tool services' deps).
 *
 * Purpose: prove END-TO-END that the binding-safe schemas bind AND invoke without
 * the `exclusiveMinimum` 400 that the strict schemas trigger (5.3 Step-0 finding),
 * and that Gemini routes to the right tool under AUTO function-calling. This is the
 * runtime confirmation the unit bug-guard (zod-to-json-schema) can only approximate.
 *
 * To enable:
 *   1. docker compose up -d   (elasticsearch + chroma + redis)
 *   2. Ensure GOOGLE_API_KEY is set in .env
 *   3. Change `describe.skip(...)` to `describe(...)` below
 *   4. Run:  npx jest tool-factory.integration.spec.ts --runInBand
 *   5. Re-add `.skip` before committing.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { LlmService } from '../llm/llm.service';
import { SearchContentToolService } from './search-content.tool';
import { QueryMetadataToolService } from './query-metadata.tool';
import { bindRoutingTools, buildRoutingTools } from './tool-factory';
import { SEARCH_CONTENT_TOOL_NAME, QUERY_METADATA_TOOL_NAME } from './tools.constants';

describe.skip('tool-factory (integration — real Gemini bindTools)', () => {
  let app: INestApplication;
  let bound: ReturnType<typeof bindRoutingTools>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const llm = moduleRef.get(LlmService);
    const tools = buildRoutingTools(
      moduleRef.get(SearchContentToolService),
      moduleRef.get(QueryMetadataToolService),
    );
    bound = bindRoutingTools(llm.createToolCallingModel(), tools);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('binds both tools and invokes WITHOUT a 400 (exclusiveMinimum regression)', async () => {
    const res = await bound.invoke('How many episodes are there?');
    expect(res).toBeDefined();
    const names = (res.tool_calls ?? []).map((c) => c.name);
    expect(names).toContain(QUERY_METADATA_TOOL_NAME);
  }, 30_000);

  it('routes a content question to search_content (AUTO)', async () => {
    const res = await bound.invoke('What did Lee Cronin say about constructor theory?');
    const names = (res.tool_calls ?? []).map((c) => c.name);
    expect(names).toContain(SEARCH_CONTENT_TOOL_NAME);
  }, 30_000);
});
