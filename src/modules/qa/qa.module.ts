import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RedisModule } from '../redis/redis.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { QaChainService } from './qa-chain.service';
import { QaController } from './qa.controller';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { RetryPolicyService } from './services/retry-policy.service';

/**
 * QA module — Phase 1.6 + 1.7 + 1.7.5 Sprint A + Phase 1.6 Sprint Retry
 * (Phase 1 / 3).
 *
 * Imports `RetrievalModule` (for `VectorRetrieverService`), `LlmModule`
 * (for chat-model factory), `RedisModule` (for `DistributedLockService` +
 * `RedisService` — Phase 1.7.5 Sprint A query-path lock guard and
 * startup integrity check), and `VectorStoreModule` (for
 * `ChromaRepository.count()` used by the startup integrity check).
 * Registers `QaController` (Phase 1.7 HTTP endpoint
 * `POST /api/v1/questions`). Exports `QaChainService` so other modules
 * (e.g. CLI smoke test, future Phase 2 evaluation) can inject it.
 *
 * `RetryPolicyService` (Phase 1) and `CircuitBreakerService` (Phase 2)
 * are provided and exported here ahead of being wired into anything —
 * Phase 3 of the retry sprint will add a `ResilientLlmService` that
 * composes both around the chat LLM call. Until then they have no
 * runtime callers; the provider registration is what proves the DI
 * container can resolve them end-to-end.
 */
@Module({
  imports: [RetrievalModule, LlmModule, RedisModule, VectorStoreModule],
  controllers: [QaController],
  providers: [QaChainService, RetryPolicyService, CircuitBreakerService],
  exports: [QaChainService, RetryPolicyService, CircuitBreakerService],
})
export class QaModule {}
