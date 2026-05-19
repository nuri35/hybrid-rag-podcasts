import { Module } from '@nestjs/common';
import { ChromaRepository } from './chroma.repository';

/**
 * Shared module wrapping the Chroma vector store client.
 *
 * Imported by:
 *   - IngestionModule  — uses ChromaRepository for upsert / count / reset
 *   - RetrievalModule  — uses ChromaRepository.similaritySearch (Phase 1.5+)
 *   - Future HybridRetrieverService (Phase 4) lives in RetrievalModule and
 *     also depends on ChromaRepository via this module.
 *
 * ChromaRepository is a singleton; the underlying ChromaClient + collection
 * cache is reused across all consumers. See ADR 0003.
 */
@Module({
  providers: [ChromaRepository],
  exports: [ChromaRepository],
})
export class VectorStoreModule {}
