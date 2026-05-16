import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { CsvLoadFailedException } from '../../../common/exceptions';
import { IngestionPipelineService } from '../services/ingestion-pipeline.service';

interface IngestCommandOptions {
  csv?: string;
  reset?: boolean;
  dryRun?: boolean;
  collection?: string;
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
      `ingest invoked: csv=${options.csv} reset=${options.reset === true} dryRun=${options.dryRun === true}`,
    );

    const result = await this.pipeline.run({
      csvPath: options.csv,
      reset: options.reset === true,
      dryRun: options.dryRun === true,
      collection: options.collection,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    description: 'Load and chunk only; skip embedding and writing',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--collection <name>',
    description: 'Override CHROMA_COLLECTION from env',
  })
  parseCollection(val: string): string {
    return val;
  }
}
