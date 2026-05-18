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
      this.logger.debug('Normalizing vectors to unit length for L2-cosine equivalence');
      this.hasLoggedNormalization = true;
    }
    let zeroVectorCount = 0;
    const normalized: number[][] = new Array<number[]>(vectors.length);
    for (let i = 0; i < vectors.length; i += 1) {
      const result = this.normalizeVector(vectors[i]);
      if (result.wasZero) {
        zeroVectorCount += 1;
      }
      normalized[i] = result.vector;
    }
    if (zeroVectorCount > 0) {
      this.logger.warn(
        `Encountered ${zeroVectorCount} zero-magnitude vector(s) during normalization; left unchanged.`,
      );
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.log(
      `Embedded ${normalized.length}/${documents.length} chunks (skipped ${skipped}); ` +
        `batches=${fulfilled}/${batches.length}; concurrency=${this.concurrency}; batchSize=${this.batchSize}; ${elapsedMs}ms`,
    );

    return normalized;
  }

  private normalizeVector(v: number[]): { vector: number[]; wasZero: boolean } {
    let magnitudeSquared = 0;
    for (let i = 0; i < v.length; i += 1) {
      magnitudeSquared += v[i] * v[i];
    }
    const magnitude = Math.sqrt(magnitudeSquared);
    if (magnitude === 0) {
      // Defensive: zero vector should never happen with real Gemini output.
      // Returning as-is keeps the array shape stable; caller is warned upstream.
      return { vector: v, wasZero: true };
    }
    const inv = 1 / magnitude;
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i += 1) {
      out[i] = v[i] * inv;
    }
    return { vector: out, wasZero: false };
  }
}
