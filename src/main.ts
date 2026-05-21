import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
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
  const app = await NestFactory.create(AppModule);

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
