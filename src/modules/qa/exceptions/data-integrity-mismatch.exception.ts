import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown by QaChainService.ask() when the startup integrity check has
 * latched the service into degraded mode — either the integrity marker
 * is missing (no successful ingestion was ever recorded) or the marker's
 * chunk count does not match Chroma's current count (mid-ingest crash,
 * out-of-band Chroma mutation, marker rollback). 503 stays in effect
 * until the operator re-runs ingestion and the next boot's startup
 * check passes.
 *
 * Distinct from IngestionInProgressException — that one is transient
 * (clears when the lock expires/releases); this one persists across
 * boots until corrective action.
 */
export class DataIntegrityMismatchException extends HttpException {
  constructor(reason: string) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: `Service is in degraded state: ${reason}. Please contact the operator.`,
        error: 'Service Unavailable',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'DataIntegrityMismatchException';
  }
}
