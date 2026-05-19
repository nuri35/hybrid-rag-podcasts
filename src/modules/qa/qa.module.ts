import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';

/**
 * QA module — Phase 1.6.
 *
 * Imports `RetrievalModule` (for `VectorRetrieverService`) and `LlmModule`
 * (for chat-model factory). `QaChainService` lands in Step 3; the
 * controller / DTO layer arrives in Phase 1.7 — both will be added here.
 *
 * Providers + exports are intentionally empty in Step 2 (scaffold-only).
 */
@Module({
  imports: [RetrievalModule, LlmModule],
  providers: [],
  exports: [],
})
export class QaModule {}
