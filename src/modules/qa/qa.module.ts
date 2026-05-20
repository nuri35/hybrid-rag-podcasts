import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { QaChainService } from './qa-chain.service';
import { QaController } from './qa.controller';

/**
 * QA module — Phase 1.6 + 1.7.
 *
 * Imports `RetrievalModule` (for `VectorRetrieverService`) and `LlmModule`
 * (for chat-model factory). Registers `QaController` (Phase 1.7 HTTP
 * endpoint `POST /api/v1/questions`). Exports `QaChainService` so other
 * modules (e.g. CLI smoke test, future Phase 2 evaluation) can inject it.
 */
@Module({
  imports: [RetrievalModule, LlmModule],
  controllers: [QaController],
  providers: [QaChainService],
  exports: [QaChainService],
})
export class QaModule {}
