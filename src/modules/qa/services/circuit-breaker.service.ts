import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import {
  CircuitState,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
} from '../types/circuit-breaker.types';
import type { Env } from '../../../common/config/env.schema';

/**
 * Phase 1.6 Sprint Retry — Phase 2 / 3.
 *
 * Classic three-state circuit breaker with a rolling time-based failure
 * window. CLOSED is the happy path; OPEN short-circuits with a 503;
 * HALF_OPEN allows exactly one probe call whose outcome decides the
 * next transition.
 *
 * State is in-memory per process — circuit decisions are local
 * observations of upstream health and do not federate across replicas.
 * Each pod / worker accumulates its own failure window. A Redis-backed
 * variant could be added later if cross-replica coordination becomes
 * useful, but for the current single-process portfolio deployment the
 * coordination overhead would buy nothing.
 *
 * Counter semantics:
 *   - Failures are timestamps stored in an array, pruned on each access
 *     to drop anything older than `windowMs`. Effective count = length
 *     after pruning.
 *   - Successes in CLOSED state are intentionally a no-op for the
 *     counter: a single success doesn't "rescue" the window, otherwise
 *     a noisy 4-fail / 1-pass / 4-fail pattern would mask a real
 *     half-broken backend. Only a successful HALF_OPEN probe transitions
 *     back to CLOSED and resets the window.
 *
 * Concurrency note: the HALF_OPEN probe is a strict single-flight. If a
 * second caller arrives while the probe is in-flight, it gets the same
 * 503 it would have got in OPEN state — we don't want concurrent probes
 * piling onto a recovering backend.
 *
 * NOT yet wired into anything; Phase 3 (ResilientLlmService) consumes
 * this primitive.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly options: CircuitBreakerOptions;

  private state: CircuitState = CircuitState.CLOSED;
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private halfOpenProbeInFlight = false;

  constructor(configService: ConfigService<Env, true>) {
    this.options = {
      failureThreshold: configService.get('LLM_CIRCUIT_FAILURE_THRESHOLD', { infer: true }),
      windowMs: configService.get('LLM_CIRCUIT_WINDOW_MS', { infer: true }),
      openDurationMs: configService.get('LLM_CIRCUIT_OPEN_DURATION_MS', { infer: true }),
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === CircuitState.OPEN) {
      const retryAfterSeconds = Math.ceil(this.timeUntilHalfOpen() / 1000);
      this.logger.warn(`circuit_blocked state=OPEN retry_after_seconds=${retryAfterSeconds}`);
      throw new CircuitOpenException(retryAfterSeconds);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenProbeInFlight) {
        // A probe is mid-flight — second caller has to wait for the
        // outcome. Conservative retryAfter: a full cool-down window,
        // since we don't know how long the probe will take.
        this.logger.warn('circuit_blocked state=HALF_OPEN reason=probe_in_flight');
        throw new CircuitOpenException(Math.ceil(this.options.openDurationMs / 1000));
      }
      this.halfOpenProbeInFlight = true;
      try {
        const result = await operation();
        this.transitionTo(CircuitState.CLOSED, 'probe_success');
        return result;
      } catch (error) {
        this.transitionTo(CircuitState.OPEN, 'probe_failure');
        throw error;
      } finally {
        this.halfOpenProbeInFlight = false;
      }
    }

    // State: CLOSED
    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  getSnapshot(): CircuitSnapshot {
    const now = Date.now();
    return {
      state: this.state,
      failureCount: this.failuresInWindow(now),
      lastFailureAt:
        this.failureTimestamps.length > 0
          ? new Date(this.failureTimestamps[this.failureTimestamps.length - 1])
          : null,
      openedAt: this.openedAt !== null ? new Date(this.openedAt) : null,
      willCloseAt:
        this.state === CircuitState.OPEN && this.openedAt !== null
          ? new Date(this.openedAt + this.options.openDurationMs)
          : null,
    };
  }

  private evaluateState(): void {
    if (this.state !== CircuitState.OPEN) return;
    if (this.openedAt === null) return;
    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= this.options.openDurationMs) {
      this.transitionTo(CircuitState.HALF_OPEN, 'cooldown_elapsed');
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.pruneOldFailures(now);

    if (this.failuresInWindow(now) >= this.options.failureThreshold) {
      this.transitionTo(CircuitState.OPEN, 'threshold_exceeded');
    }
  }

  private recordSuccess(): void {
    // See class comment — intentional no-op in CLOSED state.
  }

  private pruneOldFailures(now: number): void {
    const cutoff = now - this.options.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts > cutoff);
  }

  private failuresInWindow(now: number): number {
    this.pruneOldFailures(now);
    return this.failureTimestamps.length;
  }

  private timeUntilHalfOpen(): number {
    if (this.openedAt === null) return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.options.openDurationMs - elapsed);
  }

  private transitionTo(newState: CircuitState, reason: string): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now();
    } else if (newState === CircuitState.CLOSED) {
      this.openedAt = null;
      this.failureTimestamps = [];
    }

    this.logger.log(`circuit_transition from=${oldState} to=${newState} reason=${reason}`);
  }
}
