import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * Shared chat-model infrastructure, peer to `VectorStoreModule`.
 *
 * Consumers (Phase 1.6 `QaModule`, future evaluation / query-routing
 * modules) import this module and call `LlmService.createChatModel()` to
 * get a fresh, env-configured `ChatGoogleGenerativeAI` instance.
 */
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
