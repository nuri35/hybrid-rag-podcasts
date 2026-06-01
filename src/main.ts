import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import express, { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { Env } from './common/config/env.schema';

/**
 * Register SIGINT and SIGTERM handlers so NestJS lifecycle hooks
 * (OnModuleDestroy, ChromaRepository.onModuleDestroy, etc.) run cleanly on
 * Ctrl-C or container stop. In-flight upserts complete naturally via
 * Promise.allSettled — we do not force-cancel mid-batch.
 */
function attachShutdownHandlers(app: INestApplication): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    Logger.log(`Received ${signal}; closing app gracefully.`, 'Bootstrap');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        Logger.error(error instanceof Error ? error.stack : String(error), undefined, 'Bootstrap');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function bootstrap(): Promise<void> {
  // Pre-register Express body parsers (10 KB JSON / 10 KB urlencoded) on a
  // custom adapter BEFORE NestJS resolves the router. NestJS's own default
  // parser is disabled with `{ bodyParser: false }`, otherwise its 100 KB
  // ceiling would intercept first (default parser is registered ahead of the
  // router during `init()`, so a later `app.use(json())` lands behind the
  // route stack and never runs). 10 KB is generous headroom over the
  // 1 KB-ish JSON envelope a 1000-char `question` produces. Configurable env
  // var is deferred to Phase 1.7.5.
  const expressInstance = express();
  // Behind a load balancer / reverse proxy — trust X-Forwarded-* so
  // ProxyAwareThrottlerGuard can read the real client IP from
  // X-Forwarded-For (and Express populates req.ip from it) instead of
  // bucketing every client under the proxy's address.
  expressInstance.set('trust proxy', true);
  expressInstance.use(json({ limit: '10kb' }));
  expressInstance.use(urlencoded({ extended: true, limit: '10kb' }));

  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressInstance), {
    bodyParser: false,
  });

  // URI versioning — controllers tagged with `version: '1'` mount under /api/v1/...
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: 'api/v',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  attachShutdownHandlers(app);

  // Dev-only CORS for common local frontend dev servers (Vite 5173,
  // Next.js / CRA 3000, Angular 4200). Production CORS configuration —
  // origin allow-list, credentials, preflight max-age — is Phase 1.7.5.
  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({
      origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:4200'],
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
    });
  }

  // OpenAPI / Swagger UI at /api/docs — generated from `@ApiTags`, `@ApiProperty`,
  // `@ApiOperation`, `@ApiResponse` decorators on controllers + DTOs.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Hybrid RAG Podcasts API')
    .setDescription(
      'RAG-based Q&A over Lex Fridman Podcast transcripts. ' +
        'Retrieval-augmented generation pipeline: Gemini embeddings + Chroma vector store ' +
        '+ Gemini chat LLM composed via LangChain Expression Language (LCEL). ' +
        'Built with NestJS. Source: https://github.com/nuri35/hybrid-rag-podcasts',
    )
    .setVersion('1.0')
    .setContact('Nurettin', 'https://github.com/nuri35/hybrid-rag-podcasts', '')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addServer('http://localhost:3000', 'Local development')
    .addTag('questions', 'Q&A endpoints powered by retrieval-augmented generation')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  Logger.log(`HTTP server listening on http://localhost:${port}`, 'Bootstrap');
  Logger.log(`Swagger UI available at http://localhost:${port}/api/docs`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), undefined, 'Bootstrap');
  process.exit(1);
});
