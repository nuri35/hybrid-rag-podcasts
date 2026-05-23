/**
 * Thrown by IngestionPipelineService.run() at the commit point (post-
 * Chroma-write count check) when destination-side `actualChunks` does
 * not equal source-side `expectedChunks` from the chunker. The integrity
 * marker is NEVER written when this fires; the lock is released by the
 * finally block; next worker that acquires the lock starts fresh.
 *
 * Only meaningful when the run was a fresh ingest (--reset). Non-reset
 * idempotent re-runs skip the strict equality check because prior
 * collection contents make `actualChunks > expectedChunks` legitimate.
 */
export class IngestionIncompleteException extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      `Ingestion incomplete: expected ${expected} chunks in Chroma, ` +
        `but found ${actual}. Marker NOT written. Lock will auto-expire.`,
    );
    this.name = 'IngestionIncompleteException';
    this.expected = expected;
    this.actual = actual;
  }
}
