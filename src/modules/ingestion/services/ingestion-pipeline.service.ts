import { Injectable, Logger } from '@nestjs/common';
import { NotImplementedException } from '../../../common/exceptions';
import type { IngestionOptions, IngestionResult } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';

@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);

  constructor(
    private readonly csvLoader: CsvLoaderService,
    private readonly chunker: ChunkerService,
    private readonly embedder: EmbedderService,
  ) {}

  async run(options: IngestionOptions): Promise<IngestionResult> {
    const startedAt = Date.now();
    const isDryRun = options.dryRun === true;

    this.logger.log(
      `Starting ingestion (csv=${options.csvPath}, reset=${options.reset === true}, dryRun=${isDryRun})`,
    );

    const documents = await this.csvLoader.load(options.csvPath);
    const chunks = await this.chunker.split(documents);

    if (isDryRun) {
      const durationMs = Date.now() - startedAt;
      const result: IngestionResult = {
        rowsLoaded: documents.length,
        rowsSkipped: this.csvLoader.getLastStats()?.skipped ?? 0,
        chunksProduced: chunks.length,
        durationMs,
        dryRun: true,
      };
      this.logger.log(
        `Dry-run complete: ${result.rowsLoaded} docs, ${result.chunksProduced} chunks in ${durationMs}ms`,
      );
      return result;
    }

    const vectors = await this.embedder.embedBatch(chunks);
    this.logger.log(
      `Embedding complete: ${vectors.length} vectors produced in ${Date.now() - startedAt}ms; storage arrives in 1.3.d`,
    );

    throw new NotImplementedException(
      'IngestionPipelineService.run write path (vector storage arrives in 1.3.d ChromaRepository)',
    );
  }
}
