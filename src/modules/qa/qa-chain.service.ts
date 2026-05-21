import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import { EmbeddingFailedException } from '../../common/exceptions';
import { LlmService } from '../llm/llm.service';
import {
  EmptyQueryException,
  InvalidRetrievalOptionsException,
  QueryTooLongException,
  QueryTooShortException,
  RetrievalFailedException,
} from '../retrieval/exceptions';
import { VectorRetrieverService } from '../retrieval/vector-retriever.service';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import {
  ChromaUnreachableException,
  ChromaWriteFailedException,
} from '../vector-store/exceptions';
import { QaChainFailedException } from './exceptions';
import { NO_INFO_ANSWER } from './qa.constants';
import type { QaOptions, QaResult, QaSource } from './qa.types';
import type { Env } from '../../common/config/env.schema';

/**
 * Phase 1.6 — LLM bridge that turns retrieved chunks into a grounded answer
 * with source citations.
 *
 * Flow per `ask(question, options)`:
 *   1. Retrieve top-K chunks via `VectorRetrieverService` (Phase 1.5).
 *   2. If retrieval is empty → return the canned no-info answer WITHOUT
 *      calling the LLM. Saves cost + makes the fallback deterministic.
 *   3. Format chunks as `[Source N]\n<doc>\n\n…` context.
 *   4. Compose LCEL chain `promptTemplate | llm | StringOutputParser`
 *      and invoke it with `{ context, question }`.
 *   5. Map chunks to `QaSource[]` with truncated excerpts.
 *
 * Error policy: validation + downstream retrieval / infra exceptions pass
 * through unwrapped so the controller (Phase 1.7) maps them to clean
 * 4xx/5xx. Anything else becomes `QaChainFailedException` (500). All
 * routing is via `instanceof` — not constructor-name string match —
 * so minification cannot break it.
 */
@Injectable()
export class QaChainService {
  private readonly logger = new Logger(QaChainService.name);
  private readonly defaultTopK: number;
  private readonly sourceExcerptLength: number;
  private readonly llmTimeoutMs: number;
  private readonly promptTemplate: PromptTemplate;
  private readonly llm: BaseChatModel;
  private readonly chain: Runnable<{ context: string; question: string }, string>;

  constructor(
    private readonly retriever: VectorRetrieverService,
    llmService: LlmService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultTopK = config.get('QA_DEFAULT_TOP_K', { infer: true });
    this.sourceExcerptLength = config.get('QA_SOURCE_EXCERPT_LENGTH', { infer: true });
    this.llmTimeoutMs = config.get('LLM_TIMEOUT_MS', { infer: true });
    this.llm = llmService.createChatModel();
    this.promptTemplate = PromptTemplate.fromTemplate(
      `You are a helpful assistant answering questions based on podcast transcripts.

Use ONLY the following context to answer. If the answer is not in the context, say "${NO_INFO_ANSWER}"

Context:
{context}

Question: {question}

Answer:`,
    );
    // Chain has no per-call state — build once at startup.
    // `.pipe()` returns `Runnable<any, string>` because BaseChatModel's input
    // type is loose; the field's declared type pins the input shape at the
    // call site, which is what we want.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.chain = this.promptTemplate.pipe(this.llm).pipe(new StringOutputParser());
  }

  async ask(question: string, options: QaOptions = {}): Promise<QaResult> {
    const startTime = Date.now();
    const topK = options.topK ?? this.defaultTopK;

    this.logger.log(`qa_start question_length=${question.length} topK=${topK}`);

    try {
      // 1. Retrieve relevant chunks. Query-level validation lives in the
      //    retriever — it throws Empty/TooShort/TooLong before we get here.
      const chunks = await this.retriever.retrieve(question, { topK });

      // 2. Empty retrieval → canned fallback, NO LLM call.
      if (chunks.length === 0) {
        this.logger.warn(`qa_no_chunks question_length=${question.length}`);
        return { answer: NO_INFO_ANSWER, sources: [] };
      }

      // 3. Format chunks as a single context string for the prompt.
      const context = this.formatContext(chunks);

      // 4. Invoke the LCEL chain built once in the constructor, guarded by
      //    an LLM_TIMEOUT_MS race so a hung Gemini call cannot block the
      //    request indefinitely. Timeout failures fall to the wrap path in
      //    the catch (no instanceof match) and get correlation-ID treatment.
      const answer = await this.invokeWithTimeout(
        this.chain.invoke({ context, question }),
        this.llmTimeoutMs,
        'LLM chain invocation',
      );

      // 5. Map chunks to caller-facing source citations.
      const sources = this.mapChunksToSources(chunks);

      // Phase 2 evaluation baseline: capture score distribution per request
      // so we can later tune score thresholds and reranker comparisons.
      const topScore = chunks[0]?.score ?? 0;
      const minScore = chunks[chunks.length - 1]?.score ?? 0;
      const avgScore = chunks.length
        ? chunks.reduce((sum, c) => sum + c.score, 0) / chunks.length
        : 0;

      const duration = Date.now() - startTime;
      this.logger.log(
        `qa_complete duration_ms=${duration} sources=${sources.length} ` +
          `answer_length=${answer.length} ` +
          `top_score=${topScore.toFixed(4)} ` +
          `avg_score=${avgScore.toFixed(4)} ` +
          `min_score=${minScore.toFixed(4)}`,
      );

      return { answer, sources };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorClass = error instanceof Error ? error.constructor.name : 'Unknown';
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Pass-through path: known exceptions carry safe, intentional messages
      // (user-facing validation copy, known Chroma states). Log full detail —
      // no risk of SDK internals leaking — and re-throw to preserve the
      // exception's HTTP status code when AllExceptionsFilter handles it.
      if (
        error instanceof EmptyQueryException ||
        error instanceof QueryTooShortException ||
        error instanceof QueryTooLongException ||
        error instanceof InvalidRetrievalOptionsException ||
        error instanceof RetrievalFailedException ||
        error instanceof EmbeddingFailedException ||
        error instanceof ChromaUnreachableException ||
        error instanceof ChromaWriteFailedException
      ) {
        this.logger.error(
          `qa_failed duration_ms=${duration} ` +
            `error_class=${errorClass} ` +
            `error_message=${errorMessage}`,
        );
        throw error;
      }

      // Wrap path: Gemini SDK / LCEL / chain errors may contain URLs,
      // partial credentials, or stack traces. Generate a correlation ID,
      // log full detail server-side, and throw a sanitized exception that
      // exposes only the correlation ID to the HTTP response.
      const correlationId = randomUUID();
      this.logger.error(
        `qa_failed_wrapped correlation_id=${correlationId} ` +
          `duration_ms=${duration} ` +
          `error_class=${errorClass} ` +
          `error_message=${errorMessage}`,
      );
      throw new QaChainFailedException(correlationId);
    }
  }

  private formatContext(chunks: RetrievedChunk[]): string {
    return chunks
      .map((chunk, idx) => `[Source ${idx + 1}]\n${chunk.document}`)
      .join('\n\n');
  }

  private mapChunksToSources(chunks: RetrievedChunk[]): QaSource[] {
    return chunks.map((chunk) => ({
      chunkId: chunk.id,
      score: chunk.score,
      excerpt: this.truncateExcerpt(chunk.document),
      metadata: chunk.metadata,
    }));
  }

  private truncateExcerpt(text: string): string {
    if (text.length <= this.sourceExcerptLength) {
      return text;
    }
    return text.substring(0, this.sourceExcerptLength) + '...';
  }

  /**
   * Races the underlying promise against an `LLM_TIMEOUT_MS` setTimeout.
   * The timer is always cleared (`finally`) so a fast-resolving promise
   * does not leave a dangling handle that would keep the Node event loop
   * alive past the response. The rejection on timeout is a generic `Error`
   * — the catch in `ask()` does not match it via `instanceof`, so it falls
   * to the wrap path and surfaces with a correlation ID.
   */
  private async invokeWithTimeout<T>(
    invokePromise: Promise<T>,
    timeoutMs: number,
    contextLabel: string,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${contextLabel} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([invokePromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}
