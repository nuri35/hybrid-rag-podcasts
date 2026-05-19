import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunnableLambda, type Runnable } from '@langchain/core/runnables';
import { EmbedderService } from '../ingestion/services/embedder.service';
import {
  ChromaRepository,
  type SimilarityResult,
} from '../vector-store/chroma.repository';
import {
  ChromaUnreachableException,
  ChromaWriteFailedException,
} from '../vector-store/exceptions';
import { EmbeddingFailedException } from '../../common/exceptions';
import {
  EmptyQueryException,
  InvalidRetrievalOptionsException,
  QueryTooLongException,
  QueryTooShortException,
  RetrievalFailedException,
} from './exceptions';
import type { IRetriever, RetrievalOptions, RetrievedChunk } from './retrieval.types';
import type { Env } from '../../common/config/env.schema';

/**
 * Phase 1.5 — top-K vector retrieval over Chroma with LCEL Runnable factory.
 *
 * Flow: validate → embedQuery (RETRIEVAL_QUERY task type) → similarity search
 * (L2-on-unit-vectors, repository converts to cosine-equivalent score in
 * `[0, 1]`) → map to `RetrievedChunk[]` → optional score-threshold filter.
 *
 * Error policy: known validation / downstream exceptions are re-thrown
 * unwrapped so the controller maps them to clean 4xx/5xx. Anything else is
 * wrapped in `RetrievalFailedException` (500) so the controller doesn't leak
 * implementation details.
 *
 * Pass-through exceptions:
 *   - `EmptyQueryException`, `QueryTooShortException`, `QueryTooLongException`,
 *     `InvalidRetrievalOptionsException`  → user input problem (400)
 *   - `EmbeddingFailedException`                                    → 500
 *   - `ChromaUnreachableException`, `ChromaWriteFailedException`    → 500
 *
 * The future `HybridRetrieverService` (Phase 4) will implement the same
 * `IRetriever` interface so QaChain composition stays substitutable.
 */
@Injectable()
export class VectorRetrieverService implements IRetriever {
  private readonly logger = new Logger(VectorRetrieverService.name);
  private readonly defaultTopK: number;
  private readonly maxTopK: number;
  private readonly minQueryLength: number;
  private readonly maxQueryLength: number;

  constructor(
    private readonly embedderService: EmbedderService,
    private readonly chromaRepository: ChromaRepository,
    config: ConfigService<Env, true>,
  ) {
    this.defaultTopK = config.get('RETRIEVAL_DEFAULT_TOP_K', { infer: true });
    this.maxTopK = config.get('RETRIEVAL_MAX_TOP_K', { infer: true });
    this.minQueryLength = config.get('RETRIEVAL_MIN_QUERY_LENGTH', { infer: true });
    this.maxQueryLength = config.get('RETRIEVAL_MAX_QUERY_LENGTH', { infer: true });
  }

  async retrieve(
    query: string,
    options: RetrievalOptions = {},
  ): Promise<RetrievedChunk[]> {
    const startTime = Date.now();

    this.validateQuery(query);
    const topK = this.validateAndResolveTopK(options.topK);

    this.logger.log(`retrieve_start topK=${topK}`);

    try {
      const embedStartTime = Date.now();
      const queryVector = await this.embedderService.embedQuery(query);
      const embedDuration = Date.now() - embedStartTime;

      const searchStartTime = Date.now();
      const results = await this.chromaRepository.similaritySearch(
        queryVector,
        topK,
        options.filter,
      );
      const searchDuration = Date.now() - searchStartTime;

      let chunks = this.mapToRetrievedChunks(results);

      if (options.scoreThreshold !== undefined) {
        const beforeCount = chunks.length;
        const threshold = options.scoreThreshold;
        chunks = chunks.filter((c) => c.score >= threshold);
        this.logger.debug(
          `score_threshold_filter threshold=${threshold} kept=${chunks.length}/${beforeCount}`,
        );
      }

      const totalDuration = Date.now() - startTime;
      this.logger.log(
        `retrieve_complete returned=${chunks.length} embed_ms=${embedDuration} search_ms=${searchDuration} total_ms=${totalDuration}`,
      );

      return chunks;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`retrieve_failed duration_ms=${totalDuration} error=${message}`);

      // Known exceptions pass through unwrapped — controller maps them.
      if (
        error instanceof EmptyQueryException ||
        error instanceof QueryTooShortException ||
        error instanceof QueryTooLongException ||
        error instanceof InvalidRetrievalOptionsException ||
        error instanceof EmbeddingFailedException ||
        error instanceof ChromaUnreachableException ||
        error instanceof ChromaWriteFailedException
      ) {
        throw error;
      }
      throw new RetrievalFailedException(`Retrieval failed: ${message}`);
    }
  }

  /**
   * Adapt the retriever as a LangChain Runnable for LCEL chain composition.
   * Used by QaChain in Phase 1.6: `retriever.toRunnable() | format | prompt | llm`.
   * Options are bound at factory time; each invocation only takes the query string.
   */
  toRunnable(options: RetrievalOptions = {}): Runnable<string, RetrievedChunk[]> {
    return RunnableLambda.from(async (query: string) => this.retrieve(query, options));
  }

  private validateQuery(query: string): void {
    if (typeof query !== 'string' || query.length === 0) {
      throw new EmptyQueryException('Query must be a non-empty string');
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new EmptyQueryException('Query cannot be empty or whitespace-only');
    }
    if (trimmed.length < this.minQueryLength) {
      throw new QueryTooShortException(
        `Query must be at least ${this.minQueryLength} characters (got ${trimmed.length})`,
      );
    }
    if (trimmed.length > this.maxQueryLength) {
      throw new QueryTooLongException(
        `Query must be at most ${this.maxQueryLength} characters (got ${trimmed.length})`,
      );
    }
  }

  private validateAndResolveTopK(topK?: number): number {
    if (topK === undefined) return this.defaultTopK;
    if (!Number.isInteger(topK) || topK < 1) {
      throw new InvalidRetrievalOptionsException(
        `topK must be a positive integer (got ${topK})`,
      );
    }
    if (topK > this.maxTopK) {
      throw new InvalidRetrievalOptionsException(
        `topK exceeds maximum (max=${this.maxTopK}, got=${topK})`,
      );
    }
    return topK;
  }

  private mapToRetrievedChunks(results: SimilarityResult[]): RetrievedChunk[] {
    // ChromaRepository already converted L2 distance → cosine-equivalent score
    // (`1 - L2²/2`, clamped to `[0, 1]`). We pass it through and surface the
    // chunk_index hint from metadata for downstream consumers.
    return results.map((result, idx) => {
      const rawIndex = result.metadata['chunk_index'];
      const chunkIndex = typeof rawIndex === 'number' ? rawIndex : idx;
      return {
        id: result.id,
        document: result.document,
        score: result.score,
        metadata: result.metadata,
        chunkIndex,
      };
    });
  }
}
