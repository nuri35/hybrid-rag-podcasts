import { Module } from '@nestjs/common';
import { ChromaRepository } from '../../common/repositories/chroma.repository';
import { CsvLoaderService } from './services/csv-loader.service';
import { TextCleanerService } from './services/text-cleaner.service';
import { ChunkerService } from './services/chunker.service';
import { EmbedderService } from './services/embedder.service';
import { IngestionPipelineService } from './services/ingestion-pipeline.service';
import { IngestCommand } from './commands/ingest.command';

@Module({
  providers: [
    CsvLoaderService,
    TextCleanerService,
    ChunkerService,
    EmbedderService,
    ChromaRepository,
    IngestionPipelineService,
    IngestCommand,
  ],
  exports: [ChromaRepository],
})
export class IngestionModule {}
