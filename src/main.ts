import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  Logger.log(`HTTP server listening on http://localhost:${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), undefined, 'Bootstrap');
  process.exit(1);
});
