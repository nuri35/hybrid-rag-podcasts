import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CsvLoaderService } from '../src/modules/ingestion/services/csv-loader.service';
import { TextCleanerService } from '../src/modules/ingestion/services/text-cleaner.service';

const EPISODES_TO_INSPECT = ['1', '100', '264', '319'];
const PEEK_CHARS = 500;
const SEPARATOR = '─'.repeat(80);

function formatBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(2)} MB`;
  if (n > 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const loader = app.get(CsvLoaderService);
  const cleaner = app.get(TextCleanerService);

  const docs = await loader.load('data/podcasts.csv');
  console.log(`Loaded ${docs.length} episodes from full dataset.\n`);

  let totalBefore = 0;
  let totalAfter = 0;

  for (const targetId of EPISODES_TO_INSPECT) {
    const doc = docs.find((d) => String(d.metadata.episode_id) === targetId);
    if (!doc) {
      console.log(`⚠ Episode ${targetId} not found, skipping.\n`);
      continue;
    }

    const before = doc.pageContent;
    const after = cleaner.clean(before);

    const beforeBytes = Buffer.byteLength(before, 'utf8');
    const afterBytes = Buffer.byteLength(after, 'utf8');
    const savedBytes = beforeBytes - afterBytes;
    const savedPct = ((savedBytes / beforeBytes) * 100).toFixed(1);

    totalBefore += beforeBytes;
    totalAfter += afterBytes;

    console.log(SEPARATOR);
    console.log(`EPISODE ${targetId} — ${doc.metadata.title}`);
    console.log(`Guest: ${doc.metadata.guest_name}`);
    console.log(SEPARATOR);
    console.log(
      `Before: ${formatBytes(beforeBytes)}  →  After: ${formatBytes(afterBytes)}  ` +
        `(saved ${formatBytes(savedBytes)}, ${savedPct}%)`,
    );

    console.log('\n┌─ BEFORE: first 500 chars ──────────────────────────');
    console.log(before.slice(0, PEEK_CHARS).replace(/\n/g, ' ⏎ '));
    console.log('└─────────────────────────────────────────────────────');

    console.log('\n┌─ AFTER:  first 500 chars ──────────────────────────');
    console.log(after.slice(0, PEEK_CHARS).replace(/\n/g, ' ⏎ '));
    console.log('└─────────────────────────────────────────────────────');

    console.log('\n┌─ BEFORE: last 500 chars ───────────────────────────');
    console.log(before.slice(-PEEK_CHARS).replace(/\n/g, ' ⏎ '));
    console.log('└─────────────────────────────────────────────────────');

    console.log('\n┌─ AFTER:  last 500 chars ───────────────────────────');
    console.log(after.slice(-PEEK_CHARS).replace(/\n/g, ' ⏎ '));
    console.log('└─────────────────────────────────────────────────────\n');
  }

  console.log(SEPARATOR);
  console.log('OVERALL (inspected episodes only)');
  console.log(SEPARATOR);
  console.log(
    `Total before: ${formatBytes(totalBefore)}  →  ` +
      `Total after: ${formatBytes(totalAfter)}  ` +
      `(saved ${formatBytes(totalBefore - totalAfter)}, ` +
      `${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}%)`,
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
