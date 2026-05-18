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
  private hasLoggedNormalization = false;

  constructor(config: ConfigService<Env, true>) {
    this.batchSize = config.get('EMBEDDING_BATCH_SIZE', { infer: true });
    this.concurrency = config.get('EMBEDDING_CONCURRENCY', { infer: true });
    this.embeddings = this.createEmbeddings(config);
  }

  protected createEmbeddings(config: ConfigService<Env, true>): EmbeddingsClient {
    return new GoogleGenerativeAIEmbeddings({
      apiKey: config.get('GOOGLE_API_KEY', { infer: true }),
      model: config.get('EMBEDDING_MODEL', { infer: true }),
      taskType: TaskType.RETRIEVAL_DOCUMENT,
      maxRetries: 3,
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
        const vectors = await this.embeddings.embedDocuments(batch.texts);
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
      throw new EmbeddingFailedException(fulfilled - zeroCount, zeroCount, batches.length);
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
