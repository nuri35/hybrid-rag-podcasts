/**
 * HTTP integration for POST /api/v1/questions across the Phase 5.4 toggle.
 * Mirrors qa.controller.integration.spec.ts (ExpressAdapter + ValidationPipe +
 * versioning + AllExceptionsFilter), driving real HTTP via supertest.
 *
 * STATUS: skipped by default — needs a populated Chroma + Elasticsearch +
 * GOOGLE_API_KEY (and the podcast_episodes index for the tool-use metadata path).
 *
 * Exercises BOTH toggle states end-to-end:
 *   - TOOL_USE_ENABLED=false → path:'direct'  (classic RAG, sources populated)
 *   - TOOL_USE_ENABLED=true  → path:'tool_use' (router; sources [], toolUsed set)
 * The flag is read at facade construction, so each state recompiles AppModule with
 * the env var set in beforeAll.
 *
 * To enable: change `describe.skip` → `describe`, run
 *   npx jest qa-facade.integration.spec.ts --runInBand
 * and re-add `.skip` before committing.
 */
import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import express, { json, urlencoded } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';

interface AnswerBody {
  answer: string;
  sources: unknown[];
  path: 'direct' | 'tool_use';
  toolUsed?: string[];
}

async function bootApp(): Promise<{ app: INestApplication; server: Server }> {
  const expressInstance = express();
  expressInstance.use(json({ limit: '10kb' }));
  expressInstance.use(urlencoded({ extended: true, limit: '10kb' }));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication(new ExpressAdapter(expressInstance), {
    bodyParser: false,
  });
  app.enableVersioning({ type: VersioningType.URI, prefix: 'api/v' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return { app, server: app.getHttpServer() as Server };
}

describe.skip('QA pipeline toggle (HTTP integration — requires Chroma + ES + GOOGLE_API_KEY)', () => {
  describe('TOOL_USE_ENABLED=false → direct path', () => {
    let app: INestApplication;
    let server: Server;
    const prev = process.env.TOOL_USE_ENABLED;

    beforeAll(async () => {
      process.env.TOOL_USE_ENABLED = 'false';
      ({ app, server } = await bootApp());
    }, 30_000);

    afterAll(async () => {
      if (app) await app.close();
      process.env.TOOL_USE_ENABLED = prev;
    });

    it('answers via the direct RAG path with sources', async () => {
      const res = await request(server)
        .post('/api/v1/questions')
        .send({ question: 'What is consciousness?', topK: 3 })
        .expect(200);
      const body = res.body as AnswerBody;
      expect(body.path).toBe('direct');
      expect(typeof body.answer).toBe('string');
      expect(Array.isArray(body.sources)).toBe(true);
    }, 60_000);
  });

  describe('TOOL_USE_ENABLED=true → tool-use path', () => {
    let app: INestApplication;
    let server: Server;
    const prev = process.env.TOOL_USE_ENABLED;

    beforeAll(async () => {
      process.env.TOOL_USE_ENABLED = 'true';
      ({ app, server } = await bootApp());
    }, 30_000);

    afterAll(async () => {
      if (app) await app.close();
      process.env.TOOL_USE_ENABLED = prev;
    });

    it('answers a metadata question via the tool-use path (sources [], toolUsed set)', async () => {
      const res = await request(server)
        .post('/api/v1/questions')
        .send({ question: 'How many episodes are there?' })
        .expect(200);
      const body = res.body as AnswerBody;
      expect(body.path).toBe('tool_use');
      expect(body.sources).toEqual([]);
      expect(Array.isArray(body.toolUsed)).toBe(true);
      expect(body.answer.length).toBeGreaterThan(0);
    }, 60_000);
  });
});
