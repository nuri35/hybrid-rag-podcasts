import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  GOOGLE_API_KEY: z.string().min(1, 'GOOGLE_API_KEY is required'),
  EMBEDDING_PROVIDER: z.enum(['gemini']).default('gemini'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-004'),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  EMBEDDING_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),

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

  CLEANING_REMOVE_INTRO: z.coerce.boolean().default(true),
  CLEANING_REMOVE_OUTRO: z.coerce.boolean().default(true),
  CLEANING_REMOVE_SPONSORS: z.coerce.boolean().default(false),
  CLEANING_REMOVE_FILLERS: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;
