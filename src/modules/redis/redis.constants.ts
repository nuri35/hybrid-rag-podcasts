export const REDIS_KEYS = {
  INGESTION_LOCK: 'ingestion:in_progress',
  INGESTION_LAST_SUCCESSFUL_RUN: 'ingestion:last_successful_run',
} as const;

export type RedisKey = (typeof REDIS_KEYS)[keyof typeof REDIS_KEYS];
