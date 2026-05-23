import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RedisModule } from '../redis/redis.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { QaChainService } from './qa-chain.service';
import { QaController } from './qa.controller';

/**
 * QA module — Phase 1.6 + 1.7 + 1.7.5 Sprint A.
 *
 * Imports `RetrievalModule` (for `VectorRetrieverService`), `LlmModule`
 * (for chat-model factory), `RedisModule` (for `DistributedLockService` +
 * `RedisService` — Phase 1.7.5 Sprint A query-path lock guard and
 * startup integrity check), and `VectorStoreModule` (for
 * `ChromaRepository.count()` used by the startup integrity check).
 * Registers `QaController` (Phase 1.7 HTTP endpoint
 * `POST /api/v1/questions`). Exports `QaChainService` so other modules
 * (e.g. CLI smoke test, future Phase 2 evaluation) can inject it.
 */
@Module({
  imports: [RetrievalModule, LlmModule, RedisModule, VectorStoreModule],
  controllers: [QaController],
  providers: [QaChainService],
  exports: [QaChainService],
})
export class QaModule {}
