import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

interface CommanderLikeError extends Error {
  code?: string;
  exitCode?: number;
}

function isCommanderControlFlow(error: unknown): error is CommanderLikeError {
  if (!(error instanceof Error) || error.name !== 'CommanderError') {
    return false;
  }
  const code = (error as CommanderLikeError).code;
  return (
    code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version'
  );
}

/**
 * SIGINT and SIGTERM trigger a clean app close so OnModuleDestroy hooks
 * (e.g. ChromaRepository.onModuleDestroy) run. nest-commander's CommandFactory
 * doesn't expose the app instance, so we fall back to process.exit on signal
 * after a short grace period — in-flight Chroma upserts settle via
 * Promise.allSettled inside addDocuments().
 */
function attachSignalHandlers(): void {
  const handler = (signal: string): void => {
    Logger.warn(`Received ${signal}; exiting after current operation settles.`, 'CLI');
    setTimeout(() => process.exit(130), 5_000).unref();
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function bootstrap(): Promise<void> {
  attachSignalHandlers();
  await CommandFactory.run(AppModule, {
    logger: ['error', 'warn', 'log'],
    errorHandler: (error: Error) => {
      if (isCommanderControlFlow(error)) {
        process.exit(error.exitCode ?? 0);
      }
      Logger.error(error.message, error.stack, 'CLI');
      process.exit(1);
    },
  });
}

bootstrap().catch((error: unknown) => {
  if (isCommanderControlFlow(error)) {
    process.exit(error.exitCode ?? 0);
  }
  Logger.error(error instanceof Error ? error.stack : String(error), undefined, 'CLI');
  process.exit(1);
});
