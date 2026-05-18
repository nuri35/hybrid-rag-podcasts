import { z } from 'zod';

export const CsvRowSchema = z.object({
  episode_id: z.string().min(1, 'episode_id is required'),
  title: z.string().min(1, 'title is required'),
  transcript_text: z.string().min(100, 'transcript_text must be at least 100 characters'),
  date: z.string().optional().default(''),
  duration_min: z.preprocess((value) => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return null;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }, z.number().nullable()),
  guest_name: z.string().optional().default(''),
  guest_affiliation: z.string().optional().default(''),
  guest_role: z.string().optional().default(''),
});

export type CsvRow = z.infer<typeof CsvRowSchema>;

export interface PodcastMetadata {
  episode_id: string;
  title: string;
  date: string;
  duration_min: number | null;
  guest_name: string;
  guest_affiliation: string;
  guest_role: string;
  [key: string]: unknown;
}

export interface ChunkMetadata extends PodcastMetadata {
  chunk_id: string;
  chunk_index: number;
  total_chunks: number;
}

export interface IngestionOptions {
  csvPath: string;
  reset?: boolean;
  collection?: string;
  dryRun?: boolean;
}

export interface IngestionResult {
  rowsLoaded: number;
  rowsSkipped: number;
  chunksProduced: number;
  vectorsProduced?: number;
  durationMs: number;
  dryRun: boolean;
}
