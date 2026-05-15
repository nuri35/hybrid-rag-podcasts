import { Module } from '@nestjs/common';
import { CsvLoaderService } from './services/csv-loader.service';
import { ChunkerService } from './services/chunker.service';
import { EmbedderService } from './services/embedder.service';
import { IngestionPipelineService } from './services/ingestion-pipeline.service';

@Module({
  providers: [CsvLoaderService, ChunkerService, EmbedderService, IngestionPipelineService],
})
export class IngestionModule {}
