/**
 * Manual smoke test for the QA pipeline.
 *
 * Bootstraps the NestJS application context (no HTTP server), resolves
 * `QaChainService`, asks one question, pretty-prints the answer + sources
 * + timing, and shuts down cleanly. Dev tool only — NOT a Jest test.
 *
 * Pre-conditions:
 *   1. Chroma running:           docker compose up -d chroma
 *   2. Collection populated:     npm run cli -- ingest --csv data/podcasts.csv --reset
 *   3. .env has GOOGLE_API_KEY with embedding + chat quota
 *
 * Usage:
 *   npm run qa -- "What is consciousness?"
 *   npm run qa -- "How do neural networks learn?"
 *
 * Cost per run: 1 Gemini embed call + 1 Gemini chat call.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { QaChainService } from '../src/modules/qa/qa-chain.service';

const SEPARATOR = '='.repeat(70);
const SUBSEPARATOR = '-'.repeat(70);

function parseQuestion(): string | null {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question || question.length < 3) {
    return null;
  }
  return question;
}

function printUsage(): void {
  console.error('Usage: npm run qa -- "your question here"');
  console.error('Example: npm run qa -- "What is consciousness?"');
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  const question = parseQuestion();
  if (!question) {
    printUsage();
    process.exit(1);
  }

  // Silence info logs so the script's output isn't drowned by Nest + service
  // logs. Warnings + errors still surface so an unreachable Chroma or a
  // missing API key is immediately visible.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const qa = app.get(QaChainService);

    console.log('\n' + SEPARATOR);
    console.log(`Question: ${question}`);
    console.log(SEPARATOR);

    const startTime = Date.now();
    const result = await qa.ask(question, { topK: 5 });
    const totalDuration = Date.now() - startTime;

    console.log('\nAnswer:');
    console.log(result.answer);
    console.log();

    if (result.sources.length === 0) {
      console.log('No sources retrieved (empty context fallback — LLM was not called).');
    } else {
      console.log(`Sources (${result.sources.length}):`);
      result.sources.forEach((source, idx) => {
        console.log(
          `\n  [${idx + 1}] chunkId=${source.chunkId} score=${source.score.toFixed(4)}`,
        );
        console.log(
          `      episode_id=${formatMetadataValue(source.metadata?.episode_id)}`,
        );
        console.log(`      "${source.excerpt}"`);
      });
    }

    console.log('\n' + SUBSEPARATOR);
    console.log(`Total duration: ${totalDuration}ms`);
    console.log(SEPARATOR + '\n');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error('\nError:', message);
  if (stack) console.error(stack);
  process.exit(1);
});
