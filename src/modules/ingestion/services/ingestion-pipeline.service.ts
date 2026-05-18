import { Injectable, Logger } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { NotImplementedException } from '../../../common/exceptions';
import type { IngestionOptions, IngestionResult, PodcastMetadata } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { TextCleanerService } from './text-cleaner.service';

@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);

  constructor(
    private readonly csvLoader: CsvLoaderService,
    private readonly textCleaner: TextCleanerService,
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

    let bytesBefore = 0;
    let bytesAfter = 0;
    const cleanedDocs: Document<PodcastMetadata>[] = documents.map((doc) => {
      const original = doc.pageContent;
      const cleaned = this.textCleaner.clean(original);
      bytesBefore += Buffer.byteLength(original, 'utf8');
      bytesAfter += Buffer.byteLength(cleaned, 'utf8');
      return new Document<PodcastMetadata>({
        pageContent: cleaned,
        metadata: doc.metadata,
      });
    });
    const savedBytes = bytesBefore - bytesAfter;
    const savedPct = bytesBefore > 0 ? ((savedBytes / bytesBefore) * 100).toFixed(1) : '0.0';
    this.logger.log(
      `Cleaned ${cleanedDocs.length} documents; bytes before=${bytesBefore}, after=${bytesAfter}, saved=${savedBytes} (${savedPct}%)`,
    );

    const chunks = await this.chunker.split(cleanedDocs);

    if (isDryRun) {
      const durationMs = Date.now() - startedAt;
      const result: IngestionResult = {
        rowsLoaded: documents.length,
        rowsSkipped: this.csvLoader.getLastStats()?.skipped ?? 0,
        bytesBeforeCleaning: bytesBefore,
        bytesAfterCleaning: bytesAfter,
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
      `Embedding complete: ${vectors.length} vectors produced in ${Date.now() - startedAt}ms; storage arrives in 1.3.e`,
    );

    throw new NotImplementedException(
      'IngestionPipelineService.run write path (vector storage arrives in 1.3.e ChromaRepository)',
    );
  }
}
