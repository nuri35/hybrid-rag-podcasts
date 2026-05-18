import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { CsvLoadFailedException } from '../../../common/exceptions';
import { IngestionPipelineService } from '../services/ingestion-pipeline.service';
import type { IngestionResult } from '../types';

interface IngestCommandOptions {
  csv?: string;
  reset?: boolean;
  dryRun?: boolean;
  collection?: string;
  concurrency?: number;
}

const ROW_LABEL_WIDTH = 17;
function row(label: string, value: string | number): string {
  return `  ${label.padEnd(ROW_LABEL_WIDTH)}: ${value}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

@Command({
  name: 'ingest',
  description: 'Load a podcast CSV and ingest into the vector store',
})
export class IngestCommand extends CommandRunner {
  private readonly logger = new Logger(IngestCommand.name);

  constructor(private readonly pipeline: IngestionPipelineService) {
    super();
  }

  async run(_passedParams: string[], options: IngestCommandOptions = {}): Promise<void> {
    if (!options.csv) {
      throw new CsvLoadFailedException('(missing)', '--csv <path> is required');
    }

    this.logger.log(
      `ingest invoked: csv=${options.csv} reset=${options.reset === true} ` +
        `dryRun=${options.dryRun === true} collection=${options.collection ?? '(env default)'} ` +
        `concurrency=${options.concurrency ?? '(env default)'}`,
    );

    try {
      const result = await this.pipeline.run({
        csvPath: options.csv,
        reset: options.reset === true,
        dryRun: options.dryRun === true,
        collection: options.collection,
      });
      this.printSummary(options.csv, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Ingestion failed: ${message}`);
      process.exit(1);
    }
  }

  private printSummary(csvPath: string, result: IngestionResult): void {
    const lines: string[] = [];

    if (result.dryRun) {
      lines.push('Dry-run complete.');
    } else {
      lines.push('Ingestion complete.');
    }

    lines.push(row('Source', csvPath));
    lines.push(row('Rows loaded', formatNumber(result.rowsLoaded)));
    lines.push(row('Rows skipped', formatNumber(result.rowsSkipped)));

    if (
      typeof result.bytesBeforeCleaning === 'number' &&
      typeof result.bytesAfterCleaning === 'number'
    ) {
      const before = result.bytesBeforeCleaning;
      const after = result.bytesAfterCleaning;
      const pct = before > 0 ? ((1 - after / before) * 100).toFixed(1) : '0.0';
      lines.push(
        row('Bytes cleaned', `${formatNumber(before)} → ${formatNumber(after)} (-${pct}%)`),
      );
    }

    lines.push(row('Chunks', formatNumber(result.chunksProduced)));

    if (typeof result.vectorsProduced === 'number') {
      lines.push(row('Vectors', formatNumber(result.vectorsProduced)));
    }
    if (typeof result.collectionCount === 'number') {
      lines.push(
        row(
          'Collection',
          `${options_collectionLabel()} (${formatNumber(result.collectionCount)} total)`,
        ),
      );
    }
    if (
      typeof result.writeBatches === 'number' &&
      typeof result.writeBatchSize === 'number' &&
      typeof result.writeConcurrency === 'number'
    ) {
      lines.push(
        row(
          'Write batches',
          `${formatNumber(result.writeBatches)} (size=${result.writeBatchSize}, concurrency=${result.writeConcurrency})`,
        ),
      );
    }
    lines.push(row('Duration', `${(result.durationMs / 1000).toFixed(1)}s`));

    process.stdout.write(`${lines.join('\n')}\n`);
  }

  @Option({
    flags: '-c, --csv <path>',
    description: 'CSV file path',
  })
  parseCsv(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --reset',
    description: 'Reset target collection before ingest',
  })
  parseReset(): boolean {
    return true;
  }

  @Option({
    flags: '--dry-run',
    description: 'Load + clean + chunk only; skip embedding and writing',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--collection <name>',
    description: 'Override CHROMA_COLLECTION from env (must be set before app boot)',
  })
  parseCollection(val: string): string {
    process.env.CHROMA_COLLECTION = val;
    return val;
  }

  @Option({
    flags: '--concurrency <n>',
    description: 'Override CHROMA_WRITE_CONCURRENCY for this run',
  })
  parseConcurrency(val: string): number {
    const num = Number(val);
    if (!Number.isFinite(num) || num < 1) {
      throw new Error(`--concurrency must be a positive integer, got "${val}"`);
    }
    process.env.CHROMA_WRITE_CONCURRENCY = String(Math.floor(num));
    return Math.floor(num);
  }
}

function options_collectionLabel(): string {
  return process.env.CHROMA_COLLECTION ?? 'podcasts';
}
