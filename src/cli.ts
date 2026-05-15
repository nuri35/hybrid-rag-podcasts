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

async function bootstrap(): Promise<void> {
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
