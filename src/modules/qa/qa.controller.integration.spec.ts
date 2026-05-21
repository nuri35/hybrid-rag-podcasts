/**
 * HTTP integration tests for POST /api/v1/questions.
 * Boots the full Nest app and hits the real HTTP stack via supertest, so
 * ValidationPipe, AllExceptionsFilter, URI versioning, the 10 KB body limit,
 * and Swagger schema generation are exercised end-to-end above the service.
 *
 * STATUS: skipped by default. Re-enable manually when verifying end-to-end
 * HTTP behaviour against a populated Chroma collection + a real Gemini chat
 * model. The Phase 1.6 spec qa-chain.integration.spec.ts covers the service
 * pipeline; this one validates only the wire layer above it.
 *
 * Pre-conditions:
 *   1. Chroma running:        docker compose up -d chroma
 *   2. Collection populated:  npm run cli -- ingest --csv data/podcasts.csv --reset
 *   3. .env has a valid GOOGLE_API_KEY with both embedding + chat quota
 *
 * To enable:
 *   1. Change `describe.skip(...)` to `describe(...)` below
 *   2. Run:  npx jest qa.controller.integration.spec.ts --runInBand
 *   3. Re-add `.skip` before committing — CI does not provision Chroma + Gemini.
 *
 * Bootstrap mirrors `src/main.ts`: custom ExpressAdapter pre-loaded with the
 * 10 KB body-size limit, `{ bodyParser: false }` to skip the NestJS default
 * 100 KB parser, then global ValidationPipe / URI versioning / Swagger /
 * AllExceptionsFilter applied in the same order.
 */
import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import express, { json, urlencoded } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';

interface ValidationErrorBody {
  statusCode: number;
  message: string[];
  error: string;
}

interface QaSuccessBody {
  answer: string;
  sources: unknown[];
}

interface OpenApiBody {
  openapi: string;
  paths: Record<string, unknown>;
}

describe.skip('QaController (HTTP integration — requires Chroma + GOOGLE_API_KEY)', () => {
  let app: INestApplication;
  let httpServer: Server;

  beforeAll(async () => {
    const expressInstance = express();
    expressInstance.use(json({ limit: '10kb' }));
    expressInstance.use(urlencoded({ extended: true, limit: '10kb' }));

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication(new ExpressAdapter(expressInstance), {
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

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hybrid RAG Podcasts API')
      .setDescription('Integration-test bootstrap (mirrors main.ts)')
      .setVersion('1.0')
      .addTag('questions', 'Q&A endpoints powered by retrieval-augmented generation')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

    await app.init();
    httpServer = app.getHttpServer() as Server;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /api/v1/questions returns 200 with answer + sources for valid input', async () => {
    const response = await request(httpServer)
      .post('/api/v1/questions')
      .send({ question: 'What is consciousness?', topK: 3 })
      .expect(200);

    const body = response.body as QaSuccessBody;
    expect(typeof body.answer).toBe('string');
    expect(body.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(body.sources)).toBe(true);
  }, 60_000);

  it('POST /api/v1/questions returns 400 for too-short question', async () => {
    const response = await request(httpServer)
      .post('/api/v1/questions')
      .send({ question: 'hi' })
      .expect(400);

    const body = response.body as ValidationErrorBody;
    expect(body.statusCode).toBe(400);
    expect(body.message).toEqual(expect.arrayContaining([expect.stringContaining('longer')]));
  });

  it('POST /api/v1/questions returns 400 for unknown property (forbidNonWhitelisted)', async () => {
    const response = await request(httpServer)
      .post('/api/v1/questions')
      .send({ question: 'What is consciousness?', hackerField: 'malicious' })
      .expect(400);

    const body = response.body as ValidationErrorBody;
    expect(body.message).toEqual(expect.arrayContaining([expect.stringContaining('hackerField')]));
  });

  it('POST /api/v1/questions returns 400 for topK over limit', async () => {
    const response = await request(httpServer)
      .post('/api/v1/questions')
      .send({ question: 'What is consciousness?', topK: 100 })
      .expect(400);

    const body = response.body as ValidationErrorBody;
    expect(body.message).toEqual(expect.arrayContaining([expect.stringContaining('50')]));
  });

  it('GET /api/docs returns Swagger UI HTML', async () => {
    await request(httpServer).get('/api/docs/').expect(200).expect('Content-Type', /html/);
  });

  it('GET /api/docs-json returns OpenAPI schema with /api/v1/questions path', async () => {
    const response = await request(httpServer).get('/api/docs-json').expect(200);

    const body = response.body as OpenApiBody;
    expect(body).toHaveProperty('openapi');
    expect(body).toHaveProperty('paths');
    expect(body.paths).toHaveProperty('/api/v1/questions');
  });
});
