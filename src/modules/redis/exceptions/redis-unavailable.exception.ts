import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown by RedisService when an ioredis operation fails (connection lost,
 * timeout, server error). The original SDK error is preserved via the
 * NestJS `cause` option for server-side logging but never propagates to
 * HTTP responses — the NestJS-default ServiceUnavailableException envelope
 * hides it.
 *
 * Fail-open callers (query path, startup integrity check, health endpoint)
 * should catch this and degrade gracefully. Fail-closed callers (ingestion
 * lock acquire) should let it propagate so the caller knows Redis is the
 * blocker and not a race with another ingestion process.
 */
export class RedisUnavailableException extends ServiceUnavailableException {
  constructor(operation: string, originalError?: unknown) {
    super(`Redis operation '${operation}' failed: Redis is unreachable`, {
      cause: originalError,
    });
    this.name = 'RedisUnavailableException';
  }
}
