import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TaskType } from '@google/generative-ai';
import pLimit from 'p-limit';
import { EmbeddingFailedException } from '../../../common/exceptions';
import type { Env } from '../../../common/config/env.schema';

const LONG_CHUNK_THRESHOLD = 8000;
const STACK_LOG_MAX = 500;

interface EmbeddingsClient {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

interface BatchOutcome {
  startIdx: number;
  vectors: number[][];
}

function asString(value: unknown, fallback = '?'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

@Injectable()
export class EmbedderService {
  private readonly logger = new Logger(EmbedderService.name);
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly embeddings: EmbeddingsClient;
  // A second LangChain client constructed with `taskType: RETRIEVAL_QUERY`.
  // The wrapper bakes `taskType` into the client at construction time, so we
  // cannot override per-call — Gemini embeds documents and queries with
  // different task types for best retrieval quality, hence two instances.
  private readonly queryEmbeddings: EmbeddingsClient;
  private hasLoggedNormalization = false;

  // Two-layer rate limiting.
  // Layer 1 — token bucket: a "next available slot" timestamp shared across all
  // concurrent batches. Reservation is atomic: each call advances `lastRequestTime`
  // by `minIntervalMs` BEFORE awaiting, so concurrent callers each get a unique
  // slot. The race-prone "read-then-write" pattern is intentionally avoided.
  // Layer 2 — adaptive retry: short exponential backoff that fires on 429s OR
  // on the @langchain/google-genai 0.2.x silent-empty-array substitution that
  // hides rate-limit rejections (see embedWithAdaptiveRetry below).
  private readonly minIntervalMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryInitialDelay: number;
  private readonly retryMaxDelay: number;
  private readonly retryGrowthFactor: number;
  private lastRequestTime = 0;

  constructor(config: ConfigService<Env, true>) {
    this.batchSize = config.get('EMBEDDING_BATCH_SIZE', { infer: true });
    this.concurrency = config.get('EMBEDDING_CONCURRENCY', { infer: true });
    this.embeddings = this.createEmbeddings(config);
    this.queryEmbeddings = this.createQueryEmbeddings(config);

    const rpm = config.get('EMBEDDING_REQUESTS_PER_MINUTE', { infer: true });
    this.minIntervalMs = Math.floor(60_000 / rpm);
    this.retryMaxAttempts = config.get('EMBEDDING_RETRY_MAX_ATTEMPTS', { infer: true });
    this.retryInitialDelay = config.get('EMBEDDING_RETRY_INITIAL_DELAY_MS', { infer: true });
    this.retryMaxDelay = config.get('EMBEDDING_RETRY_MAX_DELAY_MS', { infer: true });
    this.retryGrowthFactor = config.get('EMBEDDING_RETRY_GROWTH_FACTOR', { infer: true });

    this.logger.log(
      `Token bucket: ${rpm} RPM (${this.minIntervalMs}ms between requests); ` +
        `adaptive retry: max=${this.retryMaxAttempts} attempts, ` +
        `delay=${this.retryInitialDelay}→${this.retryMaxDelay}ms × ${this.retryGrowthFactor}`,
    );
  }

  protected createEmbeddings(config: ConfigService<Env, true>): EmbeddingsClient {
    return new GoogleGenerativeAIEmbeddings({
      apiKey: config.get('GOOGLE_API_KEY', { infer: true }),
      model: config.get('EMBEDDING_MODEL', { infer: true }),
      taskType: TaskType.RETRIEVAL_DOCUMENT,
      // Disable LangChain's internal retry — we centralize all retry logic in
      // `embedWithAdaptiveRetry` so the token bucket gate runs on every attempt.
      maxRetries: 0,
    });
  }

  protected createQueryEmbeddings(config: ConfigService<Env, true>): EmbeddingsClient {
    return new GoogleGenerativeAIEmbeddings({
      apiKey: config.get('GOOGLE_API_KEY', { infer: true }),
      model: config.get('EMBEDDING_MODEL', { infer: true }),
      taskType: TaskType.RETRIEVAL_QUERY,
      maxRetries: 0,
    });
  }

  async embedBatch(documents: Document[]): Promise<number[][]> {
    const startedAt = Date.now();

    const validDocs: Document[] = [];
    for (const doc of documents) {
      if (doc.pageContent.trim().length === 0) {
        const meta = doc.metadata as { episode_id?: unknown; chunk_id?: unknown };
        this.logger.warn(
          `Skipping empty chunk (episode_id=${asString(meta.episode_id)}, chunk_id=${asString(meta.chunk_id)})`,
        );
        continue;
      }
      validDocs.push(doc);
    }
    const skipped = documents.length - validDocs.length;

    let longest = 0;
    let longestChunkId = '';
    for (const doc of validDocs) {
      if (doc.pageContent.length > longest) {
        longest = doc.pageContent.length;
        const meta = doc.metadata as { chunk_id?: unknown };
        longestChunkId = asString(meta.chunk_id);
      }
    }
    if (longest > LONG_CHUNK_THRESHOLD) {
      this.logger.warn(
        `Chunk ${longestChunkId} is ${longest} chars (>${LONG_CHUNK_THRESHOLD}); Gemini may handle but consider tighter chunk sizing`,
      );
    }

    const batches: { startIdx: number; texts: string[] }[] = [];
    for (let i = 0; i < validDocs.length; i += this.batchSize) {
      const slice = validDocs.slice(i, i + this.batchSize);
      batches.push({
        startIdx: i,
        texts: slice.map((d) => d.pageContent),
      });
    }

    const limit = pLimit(this.concurrency);
    const tasks = batches.map((batch) =>
      limit(async (): Promise<BatchOutcome> => {
        const vectors = await this.embedWithAdaptiveRetry(batch.texts);
        return { startIdx: batch.startIdx, vectors };
      }),
    );

    const settled = await Promise.allSettled(tasks);

    let fulfilled = 0;
    let rejected = 0;
    const vectors: number[][] = new Array<number[]>(validDocs.length);
    settled.forEach((outcome, batchIdx) => {
      if (outcome.status === 'fulfilled') {
        fulfilled += 1;
        outcome.value.vectors.forEach((v, j) => {
          vectors[outcome.value.startIdx + j] = v;
        });
        return;
      }
      rejected += 1;
      const reason = outcome.reason;
      const raw = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      const truncated = raw.length > STACK_LOG_MAX ? `${raw.slice(0, STACK_LOG_MAX)}…` : raw;
      this.logger.error(`Batch ${batchIdx} failed after retries: ${truncated}`);
    });

    if (rejected > 0) {
      throw new EmbeddingFailedException(fulfilled, rejected, batches.length);
    }

    // Gemini text-embedding-004 outputs are NOT unit-normalized. We normalize
    // here so downstream retrieval works with Chroma's default L2 metric:
    //   for ||a|| = ||b|| = 1,  cos(a, b) = 1 − L2²(a, b) / 2
    // i.e. L2 distance ranking is identical to cosine similarity ranking.
    // This keeps us metric-agnostic across vector DBs. Query-time vectors
    // must be normalized the same way at retrieval (Phase 1.5).
    if (!this.hasLoggedNormalization) {
      this.logger.log('Normalizing vectors to unit length for L2-cosine equivalence');
      this.hasLoggedNormalization = true;
    }

    // Pre-normalization diagnostic: inspect the first raw Gemini vector so we
    // can see what the API actually returned. Logged at info level so it shows
    // up under the default logger config.
    if (vectors.length > 0) {
      const sample: unknown = vectors[0];
      if (Array.isArray(sample) || ArrayBuffer.isView(sample)) {
        const arr = sample as ArrayLike<number>;
        let rawSumSq = 0;
        for (let i = 0; i < arr.length; i += 1) {
          const x = Number(arr[i]);
          if (Number.isFinite(x)) {
            rawSumSq += x * x;
          }
        }
        const previewSlice: number[] = [];
        for (let i = 0; i < Math.min(3, arr.length); i += 1) {
          previewSlice.push(Number(arr[i]));
        }
        this.logger.log(
          `Pre-normalization sample: type=${sample.constructor.name}, ` +
            `dims=${arr.length}, ` +
            `first 3 values=[${previewSlice.map((n) => n.toFixed(6)).join(', ')}], ` +
            `magnitude=${Math.sqrt(rawSumSq).toFixed(6)}`,
        );
      } else {
        this.logger.warn(
          `Pre-normalization sample is not an array-like: typeof=${typeof sample}`,
        );
      }
    }

    let zeroCount = 0;
    const normalizedVectors: number[][] = new Array<number[]>(vectors.length);
    for (let i = 0; i < vectors.length; i += 1) {
      const result = this.normalizeVector(vectors[i]);
      if (result.isZero) {
        zeroCount += 1;
      }
      normalizedVectors[i] = result.normalized;
    }

    if (zeroCount > 0) {
      // Empty / zero-magnitude vectors should never come from a healthy Gemini
      // response. The @langchain/google-genai 0.2.x `_embedDocumentsContent`
      // swallows underlying `batchEmbedContents` rejections (e.g. wrong model
      // name → 404, quota exhaustion → 429) by silently substituting
      // `Array(N).fill([])`. Treating that as success would poison the vector
      // store with zero vectors. We fail loud and stop the pipeline instead.
      // Counts are at vector granularity here (not batch), which is the
      // strongest signal a downstream operator needs.
      throw new EmbeddingFailedException(
        vectors.length - zeroCount,
        zeroCount,
        vectors.length,
      );
    }

    // Post-normalization sanity check on the first non-zero vector: its
    // magnitude must be ≈ 1.0 (well within float-tolerance). Logged at info
    // level so the operator can confirm normalization actually ran in prod.
    const firstNonZeroIdx = normalizedVectors.findIndex((nv, idx) => {
      const original = vectors[idx];
      if (!Array.isArray(original) && !ArrayBuffer.isView(original)) return false;
      const arr = original as ArrayLike<number>;
      let sumSq = 0;
      for (let k = 0; k < arr.length; k += 1) {
        const x = Number(arr[k]);
        if (Number.isFinite(x)) sumSq += x * x;
      }
      return sumSq >= 1e-12 && nv.length > 0;
    });
    if (firstNonZeroIdx !== -1) {
      const nv = normalizedVectors[firstNonZeroIdx];
      let postSumSq = 0;
      for (let i = 0; i < nv.length; i += 1) {
        postSumSq += nv[i] * nv[i];
      }
      this.logger.log(
        `Post-normalization sanity check: first non-zero vector magnitude = ${Math.sqrt(
          postSumSq,
        ).toFixed(6)} (expected ≈ 1.0)`,
      );
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.log(
      `Embedded ${normalizedVectors.length}/${documents.length} chunks (skipped ${skipped}); ` +
        `batches=${fulfilled}/${batches.length}; concurrency=${this.concurrency}; batchSize=${this.batchSize}; ${elapsedMs}ms`,
    );

    return normalizedVectors;
  }

  /**
   * Token bucket gate using "slot reservation" so it stays correct under
   * concurrent callers. We atomically advance `lastRequestTime` by
   * `minIntervalMs` BEFORE awaiting, so two concurrent calls each get a
   * unique slot (one fires now, the next fires `minIntervalMs` later).
   */
  private async waitForToken(): Promise<void> {
    const now = Date.now();
    const targetTime = Math.max(now, this.lastRequestTime + this.minIntervalMs);
    this.lastRequestTime = targetTime;
    const wait = targetTime - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * Rate-limit-aware embedding call. Two failure modes are handled here:
   *
   *   1. Direct 429 / quota / rate-limit error thrown by the SDK.
   *   2. The SDK silently substituting `Array(N).fill([])` when an underlying
   *      `batchEmbedContents` rejects. This is a known
   *      `@langchain/google-genai` 0.2.x bug — `_embedDocumentsContent`
   *      catches the rejection and returns empty arrays, which looks like a
   *      success but is actually a rate-limit signal. We detect this and
   *      treat it as a retryable 429.
   *
   * Token bucket is acquired on EVERY attempt so the retry honours the rate.
   */
  private async embedWithAdaptiveRetry(texts: string[]): Promise<number[][]> {
    let delay = this.retryInitialDelay;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
      await this.waitForToken();
      try {
        const result = await this.embeddings.embedDocuments(texts);
        const hasEmpty = result.some(
          (v) => !Array.isArray(v) || v.length === 0,
        );
        if (!hasEmpty) {
          return result;
        }
        lastError = new Error(
          'Empty embeddings returned — likely rate-limited (SDK silent-swallow). ' +
            'Treating as 429 for adaptive retry.',
        );
        this.logger.debug(
          `Empty-embedding hit (attempt ${attempt}/${this.retryMaxAttempts}); retrying after ${delay}ms`,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = (err as { status?: number; statusCode?: number }).status;
        const altStatus = (err as { statusCode?: number }).statusCode;
        const message = lastError.message;
        const isRateLimit =
          status === 429 ||
          altStatus === 429 ||
          /quota|rate.?limit|exhausted|too many requests/i.test(message);
        if (!isRateLimit) {
          throw lastError;
        }
        this.logger.debug(
          `Rate-limit error (attempt ${attempt}/${this.retryMaxAttempts}): ${message}; retrying after ${delay}ms`,
        );
      }

      if (attempt < this.retryMaxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * this.retryGrowthFactor, this.retryMaxDelay);
      }
    }

    throw lastError ?? new Error('Adaptive retry exhausted unexpectedly');
  }

  /**
   * Embeds a single query string with `taskType: RETRIEVAL_QUERY`.
   *
   * Mirrors the document pipeline (token bucket + adaptive retry + zero-vector
   * guard + unit normalization) but on a separate LangChain client so the task
   * type is correct. For `gemini-embedding-001` the raw output is already
   * unit-normalized, so the normalize step is idempotent — kept defensively.
   */
  async embedQuery(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingFailedException(0, 1, 1);
    }

    const rawVector = await this.embedQueryWithAdaptiveRetry(text);

    const magnitude = this.computeMagnitude(rawVector);
    if (magnitude < 1e-10) {
      throw new EmbeddingFailedException(0, 1, 1);
    }

    const { normalized } = this.normalizeVector(rawVector);

    this.logger.debug(
      `embedQuery completed: dims=${normalized.length}, magnitude=${magnitude.toFixed(6)}`,
    );

    return normalized;
  }

  /**
   * Same adaptive retry contract as `embedWithAdaptiveRetry` but for the
   * single-text query path. `embedQuery` on `@langchain/google-genai` hits
   * Gemini's `embedContent` endpoint (singular) which propagates errors
   * cleanly — no silent-empty-array substitution to detect — but we still
   * cover network blips / 429s with the same exponential backoff.
   */
  private async embedQueryWithAdaptiveRetry(text: string): Promise<number[]> {
    let delay = this.retryInitialDelay;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
      await this.waitForToken();
      try {
        const result = await this.queryEmbeddings.embedQuery(text);
        if (!Array.isArray(result) || result.length === 0) {
          lastError = new Error(
            'Empty query embedding returned — likely rate-limited (SDK silent-swallow).',
          );
          this.logger.debug(
            `Empty query embedding (attempt ${attempt}/${this.retryMaxAttempts}); retrying after ${delay}ms`,
          );
        } else {
          return result;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = (err as { status?: number; statusCode?: number }).status;
        const altStatus = (err as { statusCode?: number }).statusCode;
        const message = lastError.message;
        const isRateLimit =
          status === 429 ||
          altStatus === 429 ||
          /quota|rate.?limit|exhausted|too many requests/i.test(message);
        if (!isRateLimit) {
          throw lastError;
        }
        this.logger.debug(
          `Query rate-limit error (attempt ${attempt}/${this.retryMaxAttempts}): ${message}; retrying after ${delay}ms`,
        );
      }

      if (attempt < this.retryMaxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * this.retryGrowthFactor, this.retryMaxDelay);
      }
    }

    throw lastError ?? new Error('Adaptive retry exhausted unexpectedly');
  }

  private computeMagnitude(v: number[]): number {
    let sumSquares = 0;
    for (let i = 0; i < v.length; i += 1) {
      sumSquares += v[i] * v[i];
    }
    return Math.sqrt(sumSquares);
  }

  private normalizeVector(v: unknown): { normalized: number[]; isZero: boolean } {
    // Defensive: only normalize real number arrays (plain Array or TypedArray).
    // Anything else (undefined, null, non-array, object) is reported as zero
    // and returned as an empty array so the upsert payload stays well-typed.
    if (!Array.isArray(v) && !ArrayBuffer.isView(v)) {
      return { normalized: [], isZero: true };
    }
    const arr = v as ArrayLike<number>;
    if (arr.length === 0) {
      return { normalized: [], isZero: true };
    }
    let sumSquares = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const value = Number(arr[i]);
      if (!Number.isFinite(value)) {
        // Malformed value (NaN, Infinity, non-numeric) — bail out as zero.
        const out = new Array<number>(arr.length);
        for (let j = 0; j < arr.length; j += 1) {
          out[j] = 0;
        }
        return { normalized: out, isZero: true };
      }
      sumSquares += value * value;
    }
    // Floating-point safe check. Threshold 1e-20 is far below any realistic
    // Gemini magnitude (~0.05-2.0, so magnitudeSquared ~0.0025-4.0) but still
    // catches degenerate or numerically-vanishing inputs.
    if (sumSquares < 1e-20) {
      const out = new Array<number>(arr.length);
      for (let j = 0; j < arr.length; j += 1) {
        out[j] = Number(arr[j]);
      }
      return { normalized: out, isZero: true };
    }
    const inverseMagnitude = 1 / Math.sqrt(sumSquares);
    const normalized = new Array<number>(arr.length);
    for (let i = 0; i < arr.length; i += 1) {
      normalized[i] = Number(arr[i]) * inverseMagnitude;
    }
    return { normalized, isZero: false };
  }
}
