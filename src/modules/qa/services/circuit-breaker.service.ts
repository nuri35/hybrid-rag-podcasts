import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import {
  CircuitState,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
} from '../types/circuit-breaker.types';
import {
  CircuitBreakerRedisStorage,
  type ProbeAcquisitionResult,
} from './circuit-breaker-redis.storage';
import type { Env } from '../../../common/config/env.schema';

/**
 * Phase 1.6 Sprint Retry — Phase 2 / 3; state migrated to Redis in
 * Phase 1.7.5 Sprint Distributed-Breaker.
 *
 * Classic three-state circuit breaker (CLOSED / OPEN / HALF_OPEN) with a
 * rolling time-based failure window. CLOSED is the happy path; OPEN
 * short-circuits with a 503; HALF_OPEN allows exactly one probe whose
 * outcome decides the next transition.
 *
 * State now lives in Redis (`CircuitBreakerRedisStorage`) so a single shared
 * circuit federates across every deployed instance: when one instance trips
 * the breaker, all others immediately respect it. The three-state semantics
 * and the public `execute()` contract are unchanged — only the storage moved.
 *
 * Fail-open: if Redis is unreachable the breaker steps aside and runs the
 * operation unprotected (WARN `circuit_storage_failed action=fail_open`),
 * matching the Sprint A lock and Sprint Rate-Limit storage philosophy — the
 * circuit is a coordination optimisation, not a correctness primitive.
 *
 * Single-flight: the HALF_OPEN probe is gated by a Redis `SET NX` token, so
 * across all instances exactly one probe runs at a time. A non-probe caller
 * is reported by the storage as OPEN (blocked), never as HALF_OPEN — so the
 * invariant here is "state === HALF_OPEN ⇒ this caller is the probe-holder".
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly options: CircuitBreakerOptions;

  constructor(
    configService: ConfigService<Env, true>,
    private readonly storage: CircuitBreakerRedisStorage,
  ) {
    this.options = {
      failureThreshold: configService.get('LLM_CIRCUIT_FAILURE_THRESHOLD', { infer: true }),
      windowMs: configService.get('LLM_CIRCUIT_WINDOW_MS', { infer: true }),
      openDurationMs: configService.get('LLM_CIRCUIT_OPEN_DURATION_MS', { infer: true }),
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let resolved: ProbeAcquisitionResult;
    try {
      resolved = await this.storage.evaluateAndAcquireProbe(
        this.options.windowMs,
        this.options.openDurationMs,
      );
    } catch (error) {
      // Fail-open: Redis unreachable — skip circuit protection, run directly.
      this.logger.warn(`circuit_storage_failed action=fail_open error=${(error as Error).message}`);
      return operation();
    }

    if (resolved.state === CircuitState.OPEN) {
      const retryAfterSeconds = Math.ceil(resolved.retryAfterMs / 1000);
      this.logger.warn(`circuit_blocked state=OPEN retry_after_seconds=${retryAfterSeconds}`);
      throw new CircuitOpenException(retryAfterSeconds);
    }

    // CLOSED, or HALF_OPEN as the single probe-holder.
    if (resolved.acquiredProbe) {
      this.logger.log('circuit_transition from=OPEN to=HALF_OPEN reason=cooldown_elapsed');
    }

    try {
      const result = await operation();
      if (resolved.acquiredProbe) {
        // Probe succeeded → close the circuit for everyone.
        await this.storage.recordProbeSuccess().catch(() => undefined);
        this.logger.log('circuit_transition from=HALF_OPEN to=CLOSED reason=probe_success');
      }
      return result;
    } catch (error) {
      await this.recordFailureAndLog(resolved);
      throw error;
    }
  }

  /**
   * Read the current circuit state from Redis for diagnostics / health.
   * Best-effort: if Redis is unreachable, returns a safe CLOSED default
   * (failureCount 0, all timestamps null) rather than throwing — callers
   * should treat this as "unknown, assume healthy".
   */
  async getSnapshot(): Promise<CircuitSnapshot> {
    try {
      const snap = await this.storage.readSnapshot(this.options.windowMs);
      return {
        state: snap.state,
        failureCount: snap.failureCount,
        lastFailureAt: snap.lastFailureAtMs !== null ? new Date(snap.lastFailureAtMs) : null,
        openedAt: snap.openedAtMs !== null ? new Date(snap.openedAtMs) : null,
        willCloseAt:
          snap.state === CircuitState.OPEN && snap.openedAtMs !== null
            ? new Date(snap.openedAtMs + this.options.openDurationMs)
            : null,
      };
    } catch {
      return {
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureAt: null,
        openedAt: null,
        willCloseAt: null,
      };
    }
  }

  /**
   * Record an operation failure and, if Redis reports the circuit tripped,
   * log the transition. Wrapped in its own try/catch so a failure to RECORD
   * the failure (Redis down) never masks the original operation error.
   */
  private async recordFailureAndLog(resolved: ProbeAcquisitionResult): Promise<void> {
    try {
      const newState = await this.storage.recordFailure(
        this.options.failureThreshold,
        this.options.windowMs,
        this.options.openDurationMs,
      );
      if (newState === CircuitState.OPEN) {
        const reason = resolved.acquiredProbe ? 'probe_failure' : 'threshold_exceeded';
        this.logger.log(`circuit_transition from=${resolved.state} to=OPEN reason=${reason}`);
      }
    } catch {
      // Recording the failure itself failed (Redis down) — fail-open, nothing to do.
    }
  }
}
