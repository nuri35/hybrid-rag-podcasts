import { InternalServerErrorException } from '@nestjs/common';

/**
 * The aggregation could not be executed (Elasticsearch unreachable, timeout, or
 * a malformed response). Maps to HTTP 500 via AllExceptionsFilter.
 *
 * **Fail-loud contract (Phase 5.1).** Unlike `ElasticsearchService.search()`,
 * which fails OPEN to `[]` (a missing keyword hit is tolerable), metadata answers
 * are exactness-critical: a silently wrong or empty count would let the LLM state
 * a false fact. So a failed aggregation throws — it never returns a guessed or
 * degraded number.
 */
export class MetadataQueryFailedException extends InternalServerErrorException {
  constructor(message: string) {
    super(`Metadata aggregation failed: ${message}`);
    this.name = 'MetadataQueryFailedException';
  }
}
