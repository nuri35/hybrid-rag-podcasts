import { Module } from '@nestjs/common';
import { RrfFusionService } from './rrf-fusion.service';

/**
 * Reciprocal Rank Fusion module (Phase 4.3).
 *
 * Exposes the pure `RrfFusionService` that merges the vector and keyword ranked
 * lists. No upstream dependencies — fusion is a stateless algorithm over
 * `RetrievedChunk[]`. Exported for the future `HybridRetrievalService` (4.4),
 * which calls Chroma + Elasticsearch in parallel and fuses the two lists here.
 */
@Module({
  providers: [RrfFusionService],
  exports: [RrfFusionService],
})
export class FusionModule {}
