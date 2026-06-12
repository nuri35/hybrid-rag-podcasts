import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  GOOGLE_API_KEY: z.string().min(1, 'GOOGLE_API_KEY is required'),
  EMBEDDING_PROVIDER: z.enum(['gemini']).default('gemini'),
  EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  EMBEDDING_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  // Token bucket — hard cap on requests per minute. Tier 1: 15, Tier 2: 60, Tier 3: 200+.
  EMBEDDING_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(15),
  // Adaptive retry — short backoff for stray 429s that slip through the bucket.
  EMBEDDING_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(10),
  EMBEDDING_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(50).max(5000).default(200),
  EMBEDDING_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  EMBEDDING_RETRY_GROWTH_FACTOR: z.coerce.number().min(1).max(3).default(1.5),

  // Chroma — production-ready defaults; tune per deployment topology.
  CHROMA_URL: z.string().url().default('http://localhost:8000'),
  CHROMA_COLLECTION: z.string().min(1).default('podcasts'),
  CHROMA_DISTANCE_METRIC: z.enum(['cosine', 'l2', 'ip']).default('l2'),
  CHROMA_WRITE_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  CHROMA_WRITE_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  CHROMA_WRITE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  CHROMA_WRITE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  CHROMA_API_KEY: z.string().optional(),
  CHROMA_API_KEY_HEADER: z.string().default('X-Chroma-Token'),

  // Elasticsearch (Phase 4 — Hybrid Retrieval) — BM25 keyword side. Same var
  // name the dev-time scripts/elasticsearch/*.py use, so app and tooling point
  // at one cluster. Default matches docker-compose (single-node, port 9200).
  // Client major.minor must match the cluster (8.13.x). See ADR 0018.
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),

  CLEANING_REMOVE_INTRO: z.coerce.boolean().default(true),
  CLEANING_REMOVE_OUTRO: z.coerce.boolean().default(true),
  CLEANING_REMOVE_SPONSORS: z.coerce.boolean().default(false),
  CLEANING_REMOVE_FILLERS: z.coerce.boolean().default(false),

  // Retrieval (Phase 1.5) — query validation + topK bounds
  RETRIEVAL_DEFAULT_TOP_K: z.coerce.number().int().min(1).max(100).default(5),
  RETRIEVAL_MAX_TOP_K: z.coerce.number().int().min(1).max(500).default(50),
  RETRIEVAL_MIN_QUERY_LENGTH: z.coerce.number().int().min(1).max(100).default(3),
  RETRIEVAL_MAX_QUERY_LENGTH: z.coerce.number().int().min(10).max(10_000).default(1000),

  // LLM (Phase 1.6) — chat model for QA chain. Reuses GOOGLE_API_KEY above.
  LLM_MODEL: z.string().min(1).default('gemini-2.0-flash'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8192).default(1024),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  // QA chain (Phase 1.6)
  QA_DEFAULT_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
  QA_SOURCE_EXCERPT_LENGTH: z.coerce.number().int().min(20).max(2000).default(200),

  // LLM retry policy (Phase 1.6 Sprint Retry — Phase 1).
  // Exponential backoff with jitter. Defaults: 3 attempts, 500ms→10s with
  // 2× growth and ±30% jitter, so a worst-case total wait is ~21 s
  // (500 + 1000 + 2000 ms plus jitter, plus the operation latency itself).
  // Used only by ResilientLlmService (Phase 3 of the retry sprint) — chat
  // LLM calls only; embedder has its own retry path (Phase 1.3).
  LLM_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  LLM_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(100).max(10_000).default(500),
  LLM_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  LLM_RETRY_BACKOFF_FACTOR: z.coerce.number().min(1).max(10).default(2),
  LLM_RETRY_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.3),

  // LLM circuit breaker (Phase 1.6 Sprint Retry — Phase 2 / 3).
  // Three-state machine (CLOSED → OPEN → HALF_OPEN) sitting in front of
  // the chat LLM. Trip when 5 failures land within a 60 s rolling window;
  // cool down 30 s before letting a single probe through. In-memory
  // (process-local) by design — circuit state does not federate across
  // replicas; each pod observes upstream health independently.
  LLM_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  LLM_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  LLM_CIRCUIT_OPEN_DURATION_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),

  // Redis (Phase 1.7.5 Sprint A) — coordination layer for the distributed
  // ingestion lock, the integrity marker, and (future Sprint B) caches.
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),
  // Per-command timeout. A connected-but-unresponsive Redis (docker pause,
  // network partition, host stall) leaves ioredis commands hanging forever
  // without this — which bypasses every Redis fail-open path in the codebase.
  // 2s converts a hang into a thrown error so the existing catch/fail-open
  // logic engages. See sprint-cache validation report (2026-06-02).
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(2000),

  // Ingestion lock (Phase 1.7.5 Sprint A) — 2 h TTL is the safety net for
  // a crashed-mid-ingest process; the in-flight worker refreshes every
  // 5 min so the lock never naturally expires while work is ongoing.
  // Response cache (Phase 1.7.5 Sprint Cache) — TTL for cached non-streaming
  // QA answers. Secondary safety net beyond the ingestion-timestamp segment
  // in the cache key (which already invalidates on re-ingestion). 1 h default.
  CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

  INGESTION_LOCK_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(7200),
  INGESTION_LOCK_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10000)
    .max(1800000)
    .default(300000),

  // Rate limiting (Phase 1.7 Sprint Rate-Limit) — per-IP throttling via
  // @nestjs/throttler backed by RedisThrottlerStorage (fixed-window counter).
  // The `default` throttler covers POST /api/v1/questions; the `stream`
  // throttler is stricter because SSE connections are long-lived and heavier.
  THROTTLE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(30),
  THROTTLE_WINDOW_MS: z.coerce.number().int().min(1000).max(3600_000).default(60_000),
  THROTTLE_STREAM_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(5),
  THROTTLE_STREAM_WINDOW_MS: z.coerce.number().int().min(1000).max(3600_000).default(60_000),
});

export type Env = z.infer<typeof envSchema>;
