import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
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
import type { QaOptions, QaResult, QaSource } from './qa.types';
import type { Env } from '../../common/config/env.schema';

const NO_INFO_ANSWER = "I don't have enough information to answer this question.";

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
  private readonly promptTemplate: PromptTemplate;
  private readonly llm: BaseChatModel;

  constructor(
    private readonly retriever: VectorRetrieverService,
    llmService: LlmService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultTopK = config.get('QA_DEFAULT_TOP_K', { infer: true });
    this.sourceExcerptLength = config.get('QA_SOURCE_EXCERPT_LENGTH', { infer: true });
    this.llm = llmService.createChatModel();
    this.promptTemplate = PromptTemplate.fromTemplate(
      `You are a helpful assistant answering questions based on podcast transcripts.

Use ONLY the following context to answer. If the answer is not in the context, say "I don't have enough information to answer this question."

Context:
{context}

Question: {question}

Answer:`,
    );
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

      // 4. LCEL chain — prompt → llm → string parser.
      const chain = this.promptTemplate.pipe(this.llm).pipe(new StringOutputParser());
      const answer = await chain.invoke({ context, question });

      // 5. Map chunks to caller-facing source citations.
      const sources = this.mapChunksToSources(chunks);

      const duration = Date.now() - startTime;
      this.logger.log(
        `qa_complete duration_ms=${duration} sources=${sources.length} answer_length=${answer.length}`,
      );

      return { answer, sources };
    } catch (error) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`qa_failed duration_ms=${duration} error=${message}`);

      // Known exceptions pass through unwrapped — controller maps them.
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
        throw error;
      }
      throw new QaChainFailedException(`QA chain failed: ${message}`);
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
}
