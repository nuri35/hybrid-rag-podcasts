import { randomUUID } from 'node:crypto';
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
import {
  ALLOWED_FILTER_KEYS,
  ALLOWED_FILTER_OPERATORS,
  METADATA_KEYS,
} from './retrieval.constants';
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
    // Run filter sanitization BEFORE embedding so a malformed / disallowed
    // filter rejects in O(1) without spending a Gemini embed call on a doomed
    // request.
    const sanitizedFilter = this.sanitizeFilter(options.filter);

    this.logger.log(`retrieve_start topK=${topK}`);

    try {
      const embedStartTime = Date.now();
      const queryVector = await this.embedderService.embedQuery(query);
      const embedDuration = Date.now() - embedStartTime;

      const searchStartTime = Date.now();
      const results = await this.chromaRepository.similaritySearch(
        queryVector,
        topK,
        sanitizedFilter,
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
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;

      // Pass-through known exceptions so the controller boundary keeps their
      // HTTP status codes (`AllExceptionsFilter` maps `BadRequestException`
      // subclasses → 400 and `InternalServerErrorException` subclasses → 500).
      // Anything unknown is wrapped in `RetrievalFailedException` (500) so
      // callers see a consistent shape — see the wrap path below.
      //
      // NOTE on dead-code-but-intentional listings: the four query/option
      // validation exceptions (`EmptyQueryException`, `QueryTooShortException`,
      // `QueryTooLongException`, `InvalidRetrievalOptionsException`) cannot
      // actually reach this catch today — they are thrown by `validateQuery()`
      // and `validateAndResolveTopK()` BEFORE the `try` block opens, so they
      // bubble out directly. `ChromaUnreachableException` is similarly thrown
      // only at module-init time (`ChromaRepository.onModuleInit`), not during
      // a `similaritySearch` call. They are listed here defensively so that
      // (a) future refactoring that moves validation inside the `try`, or
      // (b) new code paths inside the `try` that legitimately throw them,
      // do not silently get re-wrapped into 500s. The cost is one cheap
      // `instanceof` check per call; the benefit is forward-defensive clarity.
      if (
        error instanceof EmptyQueryException ||
        error instanceof QueryTooShortException ||
        error instanceof QueryTooLongException ||
        error instanceof InvalidRetrievalOptionsException ||
        error instanceof EmbeddingFailedException ||
        error instanceof ChromaUnreachableException ||
        error instanceof ChromaWriteFailedException
      ) {
        this.logger.error(
          `retrieve_failed duration_ms=${totalDuration} ` +
            `error_class=${errorClass} error_message=${message}`,
        );
        throw error;
      }

      // Wrap path: the underlying error is unexpected. Its message may carry
      // SDK URLs, partial credentials, payload fragments, or stack details
      // that should not leak to the HTTP response body. We generate a
      // correlation ID, log it alongside the full original detail (so on-call
      // can grep `correlation_id=<id>` and recover everything), then throw a
      // public-safe exception that exposes ONLY the correlation ID and a
      // generic phrase. UUID source is Node's built-in `node:crypto` —
      // cryptographically strong, no new dependency.
      const correlationId = randomUUID();
      this.logger.error(
        `retrieve_failed_wrapped correlation_id=${correlationId} ` +
          `duration_ms=${totalDuration} ` +
          `error_class=${errorClass} error_message=${message}`,
      );
      throw new RetrievalFailedException(correlationId);
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

  /**
   * Whitelist-based sanitizer for `RetrievalOptions.filter`. Today no HTTP
   * surface exposes filter, but internal callers (future hybrid retriever,
   * evaluation harness, agent) can pass arbitrary shapes and Phase 1.7+ may
   * expose filter via DTO. Guarding the seam here means a permissive caller
   * cannot use Chroma's `where` clause to enumerate metadata values, compose
   * unbounded boolean queries, or filter on fields the dataset does not
   * carry (which would silently produce empty results).
   *
   * Rules:
   *   - `undefined` passes through (caller didn't ask for a filter).
   *   - Top-level value must be a plain object (not null, not array, not
   *     primitive). Arrays and primitives at the top level are malformed.
   *   - Every top-level key must be in `ALLOWED_FILTER_KEYS`. Catches
   *     `hacker_field`, `$or`, `$and`, etc. — top-level operators are
   *     deliberately rejected because they would let callers express
   *     unbounded disjunctions.
   *   - Each value is either a primitive (string / number / boolean —
   *     Chroma treats as implicit `$eq`) or a single-level operator object
   *     whose keys are all in `ALLOWED_FILTER_OPERATORS`. Operator values
   *     are NOT recursively validated — once the operator is trusted, its
   *     payload is whatever Chroma expects.
   *   - `null` / `undefined` values are rejected explicitly so callers
   *     cannot accidentally match nothing.
   *
   * Throws `InvalidRetrievalOptionsException` (→ HTTP 400) on any
   * violation; this travels the standard pass-through ladder out to the
   * controller. Sanitization runs before embedding so a doomed filter does
   * not burn a Gemini call.
   */
  private sanitizeFilter(
    filter: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (filter === undefined) {
      return undefined;
    }
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
      throw new InvalidRetrievalOptionsException('filter must be a plain object');
    }

    for (const [key, value] of Object.entries(filter)) {
      if (!ALLOWED_FILTER_KEYS.has(key)) {
        throw new InvalidRetrievalOptionsException(
          `filter contains disallowed key "${key}". ` +
            `Allowed keys: ${Array.from(ALLOWED_FILTER_KEYS).join(', ')}`,
        );
      }
      if (value === null || value === undefined) {
        throw new InvalidRetrievalOptionsException(
          `filter value for "${key}" must not be null/undefined`,
        );
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const operator of Object.keys(value)) {
          if (!ALLOWED_FILTER_OPERATORS.has(operator)) {
            throw new InvalidRetrievalOptionsException(
              `filter contains disallowed operator "${operator}" for key "${key}". ` +
                `Allowed operators: ${Array.from(ALLOWED_FILTER_OPERATORS).join(', ')}`,
            );
          }
        }
      }
      // else: primitive (string/number/boolean) → implicit equality, allowed.
    }

    return filter;
  }

  private mapToRetrievedChunks(results: SimilarityResult[]): RetrievedChunk[] {
    // ChromaRepository already converted L2 distance → cosine-equivalent score
    // (`1 - L2²/2`, clamped to `[0, 1]`). We pass it through and surface the
    // chunk_index hint from metadata for downstream consumers. The metadata key
    // is held in `METADATA_KEYS.CHUNK_INDEX` so ingestion and retrieval cannot
    // drift on a magic string; a missing or non-numeric value falls back to
    // the array index with a warn log so the schema mismatch is observable.
    return results.map((result, idx) => {
      const rawIndex = result.metadata[METADATA_KEYS.CHUNK_INDEX];
      if (typeof rawIndex === 'number') {
        return {
          id: result.id,
          document: result.document,
          score: result.score,
          metadata: result.metadata,
          chunkIndex: rawIndex,
        };
      }
      this.logger.warn(
        `metadata_chunk_index_fallback id=${result.id} ` +
          `expected_key=${METADATA_KEYS.CHUNK_INDEX} ` +
          `received_type=${typeof rawIndex} ` +
          `using_array_idx=${idx}`,
      );
      return {
        id: result.id,
        document: result.document,
        score: result.score,
        metadata: result.metadata,
        chunkIndex: idx,
      };
    });
  }
}
