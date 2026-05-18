import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import {
  ChromaClient,
  ChromaConnectionError,
  ChromaServerError,
  type Collection,
  type Metadata,
} from 'chromadb';
import pLimit from 'p-limit';
import {
  ChromaUnreachableException,
  ChromaWriteFailedException,
  type FailedBatch,
} from '../exceptions';
import type { Env } from '../config/env.schema';

const HEARTBEAT_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_JITTER_MS = 200;
const TRANSIENT_HTTP_CODES = [429, 500, 502, 503, 504] as const;
const TRANSIENT_NODE_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ABORT_ERR',
  'EAI_AGAIN',
] as const;

export interface SimilarityResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  document: string;
}

interface ChromaBatch {
  ids: string[];
  embeddings: number[][];
  metadatas: Metadata[];
  documents: string[];
}

interface ErrnoLike {
  code?: string;
  name?: string;
  message?: string;
}

/**
 * Classify an error as transient (retryable) vs. permanent (fail-fast).
 * Transient: network blips, server overload, rate-limit, timeouts.
 * Permanent: validation errors, auth errors, 4xx (except 429).
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ChromaConnectionError) return true;
  if (error instanceof ChromaServerError) return true;
  if (!(error instanceof Error)) return false;

  const errnoLike = error as Error & ErrnoLike;
  if (errnoLike.name === 'AbortError' || errnoLike.name === 'TimeoutError') return true;
  if (
    errnoLike.code &&
    TRANSIENT_NODE_CODES.includes(errnoLike.code as (typeof TRANSIENT_NODE_CODES)[number])
  ) {
    return true;
  }
  const message = error.message ?? '';
  for (const httpCode of TRANSIENT_HTTP_CODES) {
    if (new RegExp(`\\b${httpCode}\\b`).test(message)) return true;
  }
  if (/timeout|timed out/i.test(message)) return true;
  return false;
}

function flattenMetadata(meta: Record<string, unknown>): Metadata {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

@Injectable()
export class ChromaRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChromaRepository.name);
  private readonly url: string;
  private readonly collectionName: string;
  private readonly distanceMetric: 'cosine' | 'l2' | 'ip';
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiKey: string | undefined;
  private readonly apiKeyHeader: string;
  private readonly client: ChromaClient;
  private collectionCache: Collection | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('CHROMA_URL', { infer: true });
    this.collectionName = config.get('CHROMA_COLLECTION', { infer: true });
    this.distanceMetric = config.get('CHROMA_DISTANCE_METRIC', { infer: true });
    this.batchSize = config.get('CHROMA_WRITE_BATCH_SIZE', { infer: true });
    this.concurrency = config.get('CHROMA_WRITE_CONCURRENCY', { infer: true });
    this.timeoutMs = config.get('CHROMA_WRITE_TIMEOUT_MS', { infer: true });
    this.maxRetries = config.get('CHROMA_WRITE_MAX_RETRIES', { infer: true });
    this.apiKey = config.get('CHROMA_API_KEY', { infer: true });
    this.apiKeyHeader = config.get('CHROMA_API_KEY_HEADER', { infer: true });

    // Auth: pass API key via custom header. Local Chroma ignores the header.
    // We intentionally do NOT bake a shared AbortSignal into fetchOptions because
    // ChromaClient reuses the same RequestInit for every request — a shared signal
    // fired by the first long-running call would abort all subsequent calls. Per-call
    // timeouts are enforced via withTimeout() wrappers in writeBatchWithRetry/
    // similaritySearch/heartbeat/count instead.
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers[this.apiKeyHeader] = this.apiKey;
    }

    this.client = new ChromaClient({
      path: this.url,
      fetchOptions: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await withTimeout(this.client.heartbeat(), HEARTBEAT_TIMEOUT_MS, 'Chroma heartbeat');
      this.logger.log(`Chroma server reachable at ${this.url}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ChromaUnreachableException(this.url, reason);
    }
  }

  onModuleDestroy(): void {
    this.logger.log(
      'Chroma repository shutting down; in-flight upserts finish via Promise.allSettled.',
    );
  }

  async getOrCreateCollection(): Promise<Collection> {
    if (this.collectionCache !== null) {
      return this.collectionCache;
    }
    // Distance metric defaults to L2 in Chroma 0.5.x. The chromadb 1.10.x JS
    // client does not expose the new Configuration API (it hardcodes
    // `configuration: null`), and the legacy `metadata['hnsw:space']` is
    // silently ignored server-side. We compensate by storing UNIT-NORMALIZED
    // vectors (see `EmbedderService.normalizeVector`). For unit vectors,
    // L2 distance ranking ≡ cosine similarity ranking (proof:
    // cos(a,b) = 1 - L2²(a,b)/2 when ||a|| = ||b|| = 1). Retrieval-time
    // query vectors must be normalized the same way — that contract is
    // enforced in the retriever (Phase 1.5). See ADR 0006 Decision 9.
    const collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
    });
    this.collectionCache = collection;
    this.logger.log(
      `Opened Chroma collection '${this.collectionName}' (env CHROMA_DISTANCE_METRIC=${this.distanceMetric}; server uses its default L2 — ranking is cosine-equivalent via upstream unit-normalization in EmbedderService)`,
    );
    return collection;
  }

  async resetCollection(): Promise<void> {
    try {
      await this.client.deleteCollection({ name: this.collectionName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|does not exist|404/i.test(message)) {
        throw error;
      }
    }
    this.collectionCache = null;
    await this.getOrCreateCollection();
    this.logger.log(`Reset Chroma collection '${this.collectionName}'`);
  }

  async addDocuments(chunks: Document[], vectors: number[][]): Promise<void> {
    if (chunks.length !== vectors.length) {
      throw new Error(
        `addDocuments programmer error: chunks (${chunks.length}) and vectors (${vectors.length}) length mismatch`,
      );
    }
    if (chunks.length === 0) {
      this.logger.warn('addDocuments called with empty input; nothing to write.');
      return;
    }

    const collection = await this.getOrCreateCollection();
    const startedAt = Date.now();

    const batches: ChromaBatch[] = [];
    for (let i = 0; i < chunks.length; i += this.batchSize) {
      const slice = chunks.slice(i, i + this.batchSize);
      const sliceVectors = vectors.slice(i, i + this.batchSize);
      const batch: ChromaBatch = {
        ids: slice.map((chunk, idx) => {
          const meta = chunk.metadata as Record<string, unknown>;
          const chunkId = meta.chunk_id;
          if (typeof chunkId !== 'string' || chunkId.length === 0) {
            throw new Error(
              `chunk at index ${i + idx} is missing a string metadata.chunk_id; ` +
                'ChunkerService should populate this — see Phase 1.3.b.',
            );
          }
          return chunkId;
        }),
        embeddings: sliceVectors,
        metadatas: slice.map((chunk) => flattenMetadata(chunk.metadata as Record<string, unknown>)),
        documents: slice.map((chunk) => chunk.pageContent),
      };
      batches.push(batch);
    }

    const limit = pLimit(this.concurrency);
    const tasks = batches.map((batch, batchIndex) =>
      limit(async () => {
        try {
          await this.writeBatchWithRetry(collection, batch, batchIndex, 1);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          (error as Error & { batchIndex?: number }).batchIndex = batchIndex;
          throw error;
        }
      }),
    );

    const settled = await Promise.allSettled(tasks);
    let writtenBatches = 0;
    const failedBatches: FailedBatch[] = [];
    settled.forEach((outcome, idx) => {
      if (outcome.status === 'fulfilled') {
        writtenBatches += 1;
        return;
      }
      const reason = outcome.reason as Error & { batchIndex?: number; stack?: string };
      const raw = reason.stack ?? reason.message ?? String(reason);
      const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
      this.logger.error(
        `chroma_batch_terminal_failure batch=${reason.batchIndex ?? idx} reason=${truncated}`,
      );
      failedBatches.push({
        index: reason.batchIndex ?? idx,
        reason: reason.message,
      });
    });

    if (failedBatches.length > 0) {
      throw new ChromaWriteFailedException(writtenBatches, failedBatches, batches.length);
    }

    const elapsed = Date.now() - startedAt;
    this.logger.log(
      `chroma_write_complete vectors=${chunks.length} batches=${batches.length} ` +
        `concurrency=${this.concurrency} batch_size=${this.batchSize} duration_ms=${elapsed}`,
    );
  }

  private async writeBatchWithRetry(
    collection: Collection,
    batch: ChromaBatch,
    batchIndex: number,
    attempt: number,
  ): Promise<void> {
    try {
      await withTimeout(
        collection.upsert(batch),
        this.timeoutMs,
        `chroma upsert batch ${batchIndex}`,
      );
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const transient = isTransientError(error);
      if (!transient || attempt > this.maxRetries) {
        throw error;
      }
      const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      const jitter = Math.random() * (BACKOFF_JITTER_MS * 2) - BACKOFF_JITTER_MS;
      this.logger.warn(
        `chroma_batch_retry batch=${batchIndex} attempt=${attempt}/${this.maxRetries + 1} ` +
          `reason=${reason}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delay + jitter)));
      await this.writeBatchWithRetry(collection, batch, batchIndex, attempt + 1);
    }
  }

  async similaritySearch(
    queryVector: number[],
    k: number,
    filter?: Record<string, unknown>,
  ): Promise<SimilarityResult[]> {
    const collection = await this.getOrCreateCollection();
    const queryParams: Parameters<typeof collection.query>[0] = {
      queryEmbeddings: [queryVector],
      nResults: k,
    };
    if (filter !== undefined) {
      queryParams.where = filter;
    }
    const response = await withTimeout(
      collection.query(queryParams),
      this.timeoutMs,
      'chroma query',
    );

    const ids = response.ids[0] ?? [];
    const distances = response.distances?.[0] ?? [];
    const metadatas = response.metadatas?.[0] ?? [];
    const documents = response.documents?.[0] ?? [];

    const results: SimilarityResult[] = ids.map((id, idx) => {
      const distance = distances[idx] ?? 1;
      // For cosine on normalized embeddings (Gemini text-embedding-004),
      // distance ∈ [0, 1] and score = 1 - distance is a similarity ∈ [0, 1].
      // For l2/ip metrics this is not a probability; callers should be aware.
      const score = 1 - distance;
      const meta: Record<string, unknown> = metadatas[idx] ?? {};
      return {
        id,
        score,
        metadata: meta,
        document: documents[idx] ?? '',
      };
    });

    return results.sort((a, b) => b.score - a.score);
  }

  async count(): Promise<number> {
    const collection = await this.getOrCreateCollection();
    return withTimeout(collection.count(), this.timeoutMs, 'chroma count');
  }
}
