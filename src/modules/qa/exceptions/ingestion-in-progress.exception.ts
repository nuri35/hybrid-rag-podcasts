import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown by QaChainService.ask() at the entry guard when the distributed
 * ingestion lock (`ingestion:in_progress`) is held. Maps to a 503 with a
 * Retry-After hint. The client should retry once the lock has cleared —
 * the worst-case ingestion run is bounded by INGESTION_LOCK_TTL_SECONDS
 * (default 2 h) so the lock cannot be stuck indefinitely.
 */
export class IngestionInProgressException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Ingestion is currently in progress. Please retry in a few minutes.',
        error: 'Service Unavailable',
        retryAfterSeconds: 300,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'IngestionInProgressException';
  }
}
