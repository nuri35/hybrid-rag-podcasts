import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Env } from '../../common/config/env.schema';

/**
 * Shared chat-model factory.
 *
 * `createChatModel()` returns a fresh `ChatGoogleGenerativeAI` configured
 * from env. Each caller (`QaChainService` in Phase 1.6, future evaluation /
 * query-routing services) gets its own instance so per-call settings
 * (callbacks, streaming) cannot leak across consumers.
 *
 * Reuses `GOOGLE_API_KEY` — the same Gemini key that powers
 * `EmbedderService`. Token-bucket / quota concerns are owned by the
 * embedder; chat-completion quota is separate on Gemini's side.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  createChatModel(): BaseChatModel {
    return this.buildModel();
  }

  /**
   * Phase 5.3.1 — typed accessor for the tool-routing layer. Returns the
   * concrete `ChatGoogleGenerativeAI` (not the widened `BaseChatModel`) so
   * `.bindTools()` is statically available without a cast. Same construction as
   * `createChatModel()` — reuses the shared private builder, so config/model
   * stay in lock-step; routing reuses the exact production model, no new client.
   */
  createToolCallingModel(): ChatGoogleGenerativeAI {
    return this.buildModel();
  }

  private buildModel(): ChatGoogleGenerativeAI {
    const model = this.config.get('LLM_MODEL', { infer: true });
    const temperature = this.config.get('LLM_TEMPERATURE', { infer: true });
    const maxOutputTokens = this.config.get('LLM_MAX_OUTPUT_TOKENS', { infer: true });
    const timeoutMs = this.config.get('LLM_TIMEOUT_MS', { infer: true });
    const apiKey = this.config.get('GOOGLE_API_KEY', { infer: true });

    this.logger.log(
      `llm_create_model model=${model} temperature=${temperature} maxOutputTokens=${maxOutputTokens} timeout_ms=${timeoutMs}`,
    );

    // Note: `LLM_TIMEOUT_MS` is logged for visibility but ChatGoogleGenerativeAI
    // does not accept a `timeout` field directly. A Promise.race wrapper at the
    // call site (QaChainService.ask) can enforce it in a later phase if needed.
    return new ChatGoogleGenerativeAI({
      model,
      temperature,
      maxOutputTokens,
      apiKey,
    });
  }
}
