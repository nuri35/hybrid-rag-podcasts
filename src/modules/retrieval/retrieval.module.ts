import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { VectorRetrieverService } from './vector-retriever.service';

/**
 * Retrieval layer over the vector store.
 *
 * Pulls `EmbedderService` from `IngestionModule` (which re-exports it) and
 * `ChromaRepository` from `VectorStoreModule`. The future
 * `HybridRetrieverService` (Phase 4) will live alongside
 * `VectorRetrieverService` and share both upstream modules.
 */
@Module({
  imports: [IngestionModule, VectorStoreModule],
  providers: [VectorRetrieverService],
  exports: [VectorRetrieverService],
})
export class RetrievalModule {}
