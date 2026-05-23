/**
 * Thrown by IngestionPipelineService.run() when the distributed lock is
 * already held by another worker. Not an HttpException — ingestion is a
 * CLI-only path today (nest-commander), so the CLI exits non-zero and the
 * caller / operator gets a clear log line. If a future Phase 6
 * admin-endpoint exposes ingestion over HTTP, the controller layer can
 * map this to 409 Conflict.
 */
export class IngestionAlreadyRunningException extends Error {
  constructor() {
    super('Ingestion is already running. Aborting new ingestion attempt.');
    this.name = 'IngestionAlreadyRunningException';
  }
}
