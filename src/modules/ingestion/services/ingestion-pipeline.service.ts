import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { ChromaRepository } from '../../vector-store/chroma.repository';
import type { Env } from '../../../common/config/env.schema';
import type { IngestionOptions, IngestionResult, PodcastMetadata } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { TextCleanerService } from './text-cleaner.service';

@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);
  private readonly defaultBatchSize: number;
  private readonly defaultConcurrency: number;

  constructor(
    private readonly csvLoader: CsvLoaderService,
    private readonly textCleaner: TextCleanerService,
    private readonly chunker: ChunkerService,
    private readonly embedder: EmbedderService,
    private readonly chromaRepository: ChromaRepository,
    config: ConfigService<Env, true>,
  ) {
    this.defaultBatchSize = config.get('CHROMA_WRITE_BATCH_SIZE', { infer: true });
    this.defaultConcurrency = config.get('CHROMA_WRITE_CONCURRENCY', { infer: true });
  }

  async run(options: IngestionOptions): Promise<IngestionResult> {
    const startedAt = Date.now();
    const isDryRun = options.dryRun === true;

    this.logger.log(
      `Starting ingestion (csv=${options.csvPath}, reset=${options.reset === true}, dryRun=${isDryRun})`,
    );

    if (!isDryRun && options.reset === true) {
      await this.chromaRepository.resetCollection();
    }

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
    await this.chromaRepository.addDocuments(chunks, vectors);
    const collectionCount = await this.chromaRepository.count();

    const writeBatches = Math.ceil(chunks.length / this.defaultBatchSize);
    const durationMs = Date.now() - startedAt;
    const result: IngestionResult = {
      rowsLoaded: documents.length,
      rowsSkipped: this.csvLoader.getLastStats()?.skipped ?? 0,
      bytesBeforeCleaning: bytesBefore,
      bytesAfterCleaning: bytesAfter,
      chunksProduced: chunks.length,
      vectorsProduced: vectors.length,
      vectorsWritten: vectors.length,
      collectionCount,
      writeBatches,
      writeBatchSize: this.defaultBatchSize,
      writeConcurrency: this.defaultConcurrency,
      durationMs,
      dryRun: false,
    };
    this.logger.log(
      `Ingestion complete: ${result.vectorsWritten} vectors written in ${durationMs}ms; ` +
        `collection now holds ${collectionCount}`,
    );
    return result;
  }
}
