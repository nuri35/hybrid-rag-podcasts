/**
 * Integration tests for the global throttler guard + per-endpoint scoping.
 *
 * Boots the REAL controllers (QaController, HealthController) with their REAL
 * `@SkipThrottle` decorators, the REAL ProxyAwareThrottlerGuard as a global
 * APP_GUARD, and two named throttlers (`default` 30/min, `stream` 5/min). The
 * storage is the library's deterministic IN-MEMORY ThrottlerStorageService —
 * NOT our Redis-backed one — so these tests need no Redis and run in CI. The
 * Redis storage is unit-tested separately (redis-throttler.storage.spec.ts);
 * this file's job is the guard + decorator wiring (which throttler binds which
 * route, and that health bypasses entirely).
 *
 * Per-IP independence is driven through the X-Forwarded-For header, which the
 * guard reads directly — so no `trust proxy` setup is required here.
 */
import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'http';
import request from 'supertest';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';
import { HealthController } from '../../common/health/health.controller';
import { HealthService } from '../../common/health/health.service';
import { QaController } from '../qa/qa.controller';
import { QaChainService } from '../qa/qa-chain.service';
import type { StreamEvent } from '../qa/dto/stream-event.types';

const DEFAULT_LIMIT = 30;
const STREAM_LIMIT = 5;

function makeStream(): AsyncGenerator<StreamEvent, void, void> {
  return (async function* () {
    await Promise.resolve(); // satisfy require-await for the async generator
    yield { type: 'sources', data: [] };
    yield { type: 'done', data: { totalChunks: 0 } };
  })();
}

describe('Throttler integration (guard + per-endpoint scoping, in-memory storage)', () => {
  let app: INestApplication;
  let httpServer: Server;

  const qaChainMock = {
    ask: jest.fn().mockResolvedValue({ answer: 'mock answer [Source 1]', sources: [] }),
    askStream: jest.fn(() => makeStream()),
  };
  const healthMock = {
    check: jest.fn().mockResolvedValue({ status: 'ok' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: 60_000, limit: DEFAULT_LIMIT },
            { name: 'stream', ttl: 60_000, limit: STREAM_LIMIT },
          ],
          // default in-memory ThrottlerStorageService (deterministic, no Redis)
        }),
      ],
      controllers: [QaController, HealthController],
      providers: [
        { provide: APP_GUARD, useClass: ProxyAwareThrottlerGuard },
        { provide: QaChainService, useValue: qaChainMock },
        { provide: HealthService, useValue: healthMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, prefix: 'api/v' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('bypasses throttling on /health (well beyond the default limit)', async () => {
    const xff = '10.0.0.1';
    for (let i = 0; i < DEFAULT_LIMIT + 5; i++) {
      await request(httpServer).get('/health').set('X-Forwarded-For', xff).expect(200);
    }
  }, 30_000);

  it('allows DEFAULT_LIMIT question requests then 429s the next', async () => {
    const xff = '10.0.0.2';
    for (let i = 0; i < DEFAULT_LIMIT; i++) {
      await request(httpServer)
        .post('/api/v1/questions')
        .set('X-Forwarded-For', xff)
        .send({ question: 'What is consciousness?' })
        .expect(200);
    }
    await request(httpServer)
      .post('/api/v1/questions')
      .set('X-Forwarded-For', xff)
      .send({ question: 'What is consciousness?' })
      .expect(429);
  }, 30_000);

  it('allows STREAM_LIMIT stream requests then 429s the next', async () => {
    const xff = '10.0.0.3';
    for (let i = 0; i < STREAM_LIMIT; i++) {
      await request(httpServer)
        .get('/api/v1/questions/stream?question=What%20is%20consciousness')
        .set('X-Forwarded-For', xff)
        .expect(200);
    }
    await request(httpServer)
      .get('/api/v1/questions/stream?question=What%20is%20consciousness')
      .set('X-Forwarded-For', xff)
      .expect(429);
  }, 30_000);

  it('keeps the stream throttler independent of the question throttler for one IP', async () => {
    // Same IP: exhaust the stricter stream limit, then confirm the question
    // endpoint (default throttler) is still fully available — proving the
    // @SkipThrottle scoping gives each endpoint its own counter.
    const xff = '10.0.0.4';
    for (let i = 0; i < STREAM_LIMIT; i++) {
      await request(httpServer)
        .get('/api/v1/questions/stream?question=hello%20world')
        .set('X-Forwarded-For', xff)
        .expect(200);
    }
    await request(httpServer)
      .get('/api/v1/questions/stream?question=hello%20world')
      .set('X-Forwarded-For', xff)
      .expect(429);

    // Question endpoint untouched for this IP.
    await request(httpServer)
      .post('/api/v1/questions')
      .set('X-Forwarded-For', xff)
      .send({ question: 'What is consciousness?' })
      .expect(200);
  }, 30_000);

  it('tracks counters independently per client IP (X-Forwarded-For)', async () => {
    const exhausted = '10.0.0.5';
    for (let i = 0; i < DEFAULT_LIMIT; i++) {
      await request(httpServer)
        .post('/api/v1/questions')
        .set('X-Forwarded-For', exhausted)
        .send({ question: 'What is consciousness?' })
        .expect(200);
    }
    await request(httpServer)
      .post('/api/v1/questions')
      .set('X-Forwarded-For', exhausted)
      .send({ question: 'What is consciousness?' })
      .expect(429);

    // A different client IP starts with a fresh counter.
    await request(httpServer)
      .post('/api/v1/questions')
      .set('X-Forwarded-For', '10.0.0.6')
      .send({ question: 'What is consciousness?' })
      .expect(200);
  }, 30_000);
});
