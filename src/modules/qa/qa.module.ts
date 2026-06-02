import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RedisModule } from '../redis/redis.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { QaChainService } from './qa-chain.service';
import { QaController } from './qa.controller';
import { CircuitBreakerRedisStorage } from './services/circuit-breaker-redis.storage';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { OutputValidationService } from './services/output-validation.service';
import { PromptSanitizationService } from './services/prompt-sanitization.service';
import { QaResponseCacheService } from './services/qa-response-cache.service';
import { ResilientLlmService } from './services/resilient-llm.service';
import { RetryPolicyService } from './services/retry-policy.service';
import { TokenUsageService } from './services/token-usage.service';

/**
 * QA module — Phase 1.6 + 1.7 + 1.7.5 Sprint A + Phase 1.6 Sprint Retry
 * (Phases 1 / 2 / 3).
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
 * Sprint Retry composition (in DI order, not call order):
 *   - `RetryPolicyService` — Phase 1 primitive (exponential backoff +
 *     jitter + retryable classification).
 *   - `CircuitBreakerService` — Phase 2 primitive (three-state machine
 *     over a rolling failure window).
 *   - `ResilientLlmService` — Phase 3 composer that wraps every chat
 *     LLM `chain.invoke()` with circuit (outer) + retry (inner).
 *     Consumed by `QaChainService.ask()`.
 */
@Module({
  imports: [RetrievalModule, LlmModule, RedisModule, VectorStoreModule],
  controllers: [QaController],
  providers: [
    QaChainService,
    RetryPolicyService,
    CircuitBreakerRedisStorage,
    CircuitBreakerService,
    ResilientLlmService,
    TokenUsageService,
    PromptSanitizationService,
    OutputValidationService,
    QaResponseCacheService,
  ],
  exports: [
    QaChainService,
    RetryPolicyService,
    CircuitBreakerService,
    ResilientLlmService,
    TokenUsageService,
    PromptSanitizationService,
    OutputValidationService,
  ],
})
export class QaModule {}
