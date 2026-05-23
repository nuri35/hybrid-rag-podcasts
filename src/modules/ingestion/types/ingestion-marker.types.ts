/**
 * Shape of the Redis-backed `ingestion:last_successful_run` value.
 *
 * Written ONLY after a successful ingestion run that passed the
 * post-write integrity check. Read at QaChainService boot to verify
 * data integrity before accepting queries.
 *
 * Source-file-hash check at startup is deferred to a later sprint (see
 * ADR 0009); the field is captured here so it's available when that
 * sprint enables the comparison.
 */
export interface IngestionMarker {
  timestamp: string;
  expectedChunks: number;
  actualChunks: number;
  sourceFileHash: string;
  durationMs: number;
  ingestionVersion: string;
}
