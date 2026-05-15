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

export interface IngestionOptions {
  csvPath: string;
  reset?: boolean;
  collection?: string;
}

export interface IngestionResult {
  rowsProcessed: number;
  chunksCreated: number;
  tokensConsumed: number;
  durationMs: number;
  estimatedCostUsd: number;
}
