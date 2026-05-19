import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { QaChainService } from './qa-chain.service';

/**
 * QA module — Phase 1.6.
 *
 * Imports `RetrievalModule` (for `VectorRetrieverService`) and `LlmModule`
 * (for chat-model factory). Exports `QaChainService` so the Phase 1.7
 * controller can inject it.
 */
@Module({
  imports: [RetrievalModule, LlmModule],
  providers: [QaChainService],
  exports: [QaChainService],
})
export class QaModule {}
