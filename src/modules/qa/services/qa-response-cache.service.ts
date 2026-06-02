import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.constants';
import { QA_PROMPT_TEMPLATE } from '../qa.constants';
import type { Env } from '../../../common/config/env.schema';
import type { BuildKeyInput, CachedResponse } from './qa-response-cache.types';

const CACHE_VERSION = 'v1';
const CACHE_KEY_PREFIX = 'qa';
const INGESTION_FALLBACK = 'none';

/**
 * Phase 1.7.5 Sprint Cache (Cache C) — Redis-backed exact-match cache for
 * the non-streaming QA endpoint. Owns three concerns:
 *   1. Cache-key construction (`buildKey`) — a pure, deterministic
 *      content hash scoped to model / temperature / prompt / topK /
 *      ingestion version, so a cached answer is only ever returned for
 *      the exact inputs that produced it.
 *   2. Read / write with JSON (de)serialisation.
 *   3. Fail-open handling — every Redis error degrades to a cache miss
 *      (read) or a silent no-op (write); the caller's normal pipeline is
 *      never blocked. Same philosophy as Sprint A, Sprint Rate-Limit, and
 *      Sprint Distributed-Breaker: the cache is a latency/cost
 *      optimisation, not a correctness primitive.
 *
 * `RedisService` methods THROW `RedisUnavailableException` on failure, so
 * every public method wraps them in try/catch. `set` uses the existing
 * `RedisService.set(key, value, ttlSeconds)` overload — the spec's
 * `setEx` does not exist and is unnecessary.
 *
 * `promptHash` is computed once at construction from `QA_PROMPT_TEMPLATE`
 * (the same constant `QaChainService` feeds to `PromptTemplate`). It is a
 * public readonly field so `QaChainService` can pass it into `buildKey`.
 */
@Injectable()
export class QaResponseCacheService {
  private readonly logger = new Logger(QaResponseCacheService.name);

  /** First 8 hex chars of SHA-256(QA_PROMPT_TEMPLATE). */
  readonly promptHash: string;

  private readonly ttlSeconds: number;

  constructor(
    private readonly redisService: RedisService,
    configService: ConfigService<Env, true>,
  ) {
    this.promptHash = createHash('sha256').update(QA_PROMPT_TEMPLATE).digest('hex').slice(0, 8);
    this.ttlSeconds = configService.get('CACHE_TTL_SECONDS', { infer: true });
  }

  /**
   * Build the cache key. Pure function — does not touch Redis. The content
   * hash folds in the normalized question (lowercase + trim + NFC) and the
   * sorted chunk IDs, so case / whitespace / unicode-form / chunk-order
   * variations all collapse to the same key.
   */
  buildKey(input: BuildKeyInput): string {
    const normalized = input.question.toLowerCase().trim().normalize('NFC');
    const sortedChunks = [...input.chunkIds].sort().join(',');
    const contentInput = `${normalized}|${sortedChunks}`;
    const contentHash = createHash('sha256').update(contentInput).digest('hex');

    return [
      CACHE_KEY_PREFIX,
      CACHE_VERSION,
      input.model,
      input.temperature,
      input.promptHash,
      input.topK,
      input.ingestionTimestamp,
      contentHash,
    ].join(':');
  }

  /**
   * Fetch the current ingestion timestamp from Sprint A's marker
   * (`ingestion:last_successful_run`). The marker is the JSON
   * `IngestionMarker` blob; we read its `timestamp` field. Returns `none`
   * if Redis is unreachable or the key is absent, and falls back to the
   * raw value if some installation stored a bare timestamp string.
   */
  async getIngestionTimestamp(): Promise<string> {
    try {
      const value = await this.redisService.get(REDIS_KEYS.INGESTION_LAST_SUCCESSFUL_RUN);
      if (!value) return INGESTION_FALLBACK;
      try {
        const parsed = JSON.parse(value) as { timestamp?: string };
        return parsed.timestamp ?? INGESTION_FALLBACK;
      } catch {
        // Marker is a raw timestamp string rather than a JSON blob.
        return value;
      }
    } catch (error) {
      this.logger.warn(
        `qa_cache_ingestion_marker_read_failed action=fail_open error=${this.message(error)}`,
      );
      return INGESTION_FALLBACK;
    }
  }

  /**
   * Get a cached response. Returns null on cache miss, fail-open, or a
   * corrupt entry (which is deleted so we stop hitting the same garbage).
   */
  async get(key: string, correlationId: string): Promise<CachedResponse | null> {
    try {
      const raw = await this.redisService.get(key);
      if (!raw) {
        this.logger.log(`qa_cache_miss correlation_id=${correlationId} cache_key=${key}`);
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as CachedResponse;
        this.logger.log(`qa_cache_hit correlation_id=${correlationId} cache_key=${key}`);
        return parsed;
      } catch (parseError) {
        this.logger.warn(
          `qa_cache_corrupt_entry correlation_id=${correlationId} cache_key=${key} ` +
            `error=${this.message(parseError)}`,
        );
        await this.redisService.del(key).catch(() => undefined);
        return null;
      }
    } catch (error) {
      this.logger.warn(
        `qa_cache_failed action=fail_open correlation_id=${correlationId} stage=read ` +
          `error=${this.message(error)}`,
      );
      return null;
    }
  }

  /**
   * Store a response in the cache. Fails silently — a cache write must
   * never break the user's request, so Redis errors are logged and
   * swallowed (the answer was already returned to the caller).
   */
  async set(key: string, response: CachedResponse, correlationId: string): Promise<void> {
    try {
      await this.redisService.set(key, JSON.stringify(response), this.ttlSeconds);
      this.logger.log(
        `qa_cache_stored correlation_id=${correlationId} cache_key=${key} ` +
          `ttl_seconds=${this.ttlSeconds}`,
      );
    } catch (error) {
      this.logger.warn(
        `qa_cache_failed action=fail_open correlation_id=${correlationId} stage=write ` +
          `error=${this.message(error)}`,
      );
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
