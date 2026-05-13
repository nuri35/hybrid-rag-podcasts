import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  CHROMA_PATH: z.string().min(1).default('./data/chroma'),
  CHROMA_COLLECTION: z.string().min(1).default('podcasts'),
});

export type Env = z.infer<typeof envSchema>;
