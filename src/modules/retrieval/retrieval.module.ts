import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';

/**
 * Retrieval layer over the vector store.
 *
 * Pulls `EmbedderService` from `IngestionModule` (which re-exports it) and
 * `ChromaRepository` from `VectorStoreModule`. The future
 * `HybridRetrieverService` (Phase 4) will live in this same module alongside
 * `VectorRetrieverService` (Phase 1.5).
 *
 * Providers + exports are filled in by Step 3 (`VectorRetrieverService`).
 * Step 2 only scaffolds the module so AppModule can wire it.
 */
@Module({
  imports: [IngestionModule, VectorStoreModule],
  providers: [],
  exports: [],
})
export class RetrievalModule {}
