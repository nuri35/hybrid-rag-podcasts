import { Module } from '@nestjs/common';
import { ElasticsearchModule } from '../elasticsearch/elasticsearch.module';
import { FusionModule } from '../fusion/fusion.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { NeighborExpansionService } from './neighbor-expansion.service';
import { VectorRetrieverService } from './vector-retriever.service';

/**
 * Retrieval layer.
 *
 * Pulls `EmbedderService` from `IngestionModule` (re-exported) and
 * `ChromaRepository` from `VectorStoreModule` for the vector path. Phase 4.4
 * adds `HybridRetrievalService`, which orchestrates `VectorRetrieverService` +
 * `ElasticsearchService` (from `ElasticsearchModule`) + `RrfFusionService` (from
 * `FusionModule`) and, post-fusion, `NeighborExpansionService` (±1 context
 * completion via `ChromaRepository`). Both retrievers are exported; `QaModule`
 * binds the active one behind the `RETRIEVER` token via `HYBRID_RETRIEVAL_ENABLED`.
 */
@Module({
  imports: [IngestionModule, VectorStoreModule, ElasticsearchModule, FusionModule],
  providers: [VectorRetrieverService, HybridRetrievalService, NeighborExpansionService],
  exports: [VectorRetrieverService, HybridRetrievalService],
})
export class RetrievalModule {}
