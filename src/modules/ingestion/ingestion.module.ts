import { Module } from '@nestjs/common';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { CsvLoaderService } from './services/csv-loader.service';
import { TextCleanerService } from './services/text-cleaner.service';
import { ChunkerService } from './services/chunker.service';
import { EmbedderService } from './services/embedder.service';
import { IngestionPipelineService } from './services/ingestion-pipeline.service';
import { IngestCommand } from './commands/ingest.command';

@Module({
  imports: [VectorStoreModule],
  providers: [
    CsvLoaderService,
    TextCleanerService,
    ChunkerService,
    EmbedderService,
    IngestionPipelineService,
    IngestCommand,
  ],
})
export class IngestionModule {}
