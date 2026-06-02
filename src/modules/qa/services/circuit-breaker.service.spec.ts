import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../common/config/env.schema';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import { CircuitState } from '../types/circuit-breaker.types';
import type {
  CircuitBreakerRedisStorage,
  CircuitStateSnapshot,
  ProbeAcquisitionResult,
} from './circuit-breaker-redis.storage';
import { CircuitBreakerService } from './circuit-breaker.service';

/**
 * Post-migration unit tests. State now lives in Redis, so these drive the
 * public `execute()` / `getSnapshot()` API with a MOCKED
 * CircuitBreakerRedisStorage rather than asserting internal fields (which no
 * longer exist). The Lua state machine itself is covered by
 * circuit-breaker-redis.storage.integration.spec.ts against live Redis.
 */
interface MockStorage {
  evaluateAndAcquireProbe: jest.Mock<Promise<ProbeAcquisitionResult>, [number, number]>;
  recordFailure: jest.Mock<Promise<CircuitState>, [number, number, number]>;
  recordProbeSuccess: jest.Mock<Promise<void>, []>;
  readSnapshot: jest.Mock<Promise<CircuitStateSnapshot>, [number]>;
}

const THRESHOLD = 5;
const WINDOW_MS = 60_000;
const OPEN_MS = 30_000;

function makeConfig(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    LLM_CIRCUIT_FAILURE_THRESHOLD: THRESHOLD,
    LLM_CIRCUIT_WINDOW_MS: WINDOW_MS,
    LLM_CIRCUIT_OPEN_DURATION_MS: OPEN_MS,
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService<Env, true>;
}

function makeStorage(): MockStorage {
  return {
    evaluateAndAcquireProbe: jest.fn<Promise<ProbeAcquisitionResult>, [number, number]>(),
    recordFailure: jest.fn<Promise<CircuitState>, [number, number, number]>(),
    recordProbeSuccess: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    readSnapshot: jest.fn<Promise<CircuitStateSnapshot>, [number]>(),
  };
}

function build(storage: MockStorage): CircuitBreakerService {
  return new CircuitBreakerService(makeConfig(), storage as unknown as CircuitBreakerRedisStorage);
}

const CLOSED_RESULT: ProbeAcquisitionResult = {
  state: CircuitState.CLOSED,
  acquiredProbe: false,
  retryAfterMs: 0,
};

describe('CircuitBreakerService (Redis-backed)', () => {
  let storage: MockStorage;
  let service: CircuitBreakerService;

  beforeEach(() => {
    storage = makeStorage();
    service = build(storage);
  });

  afterEach(() => jest.restoreAllMocks());

  // ---------------------------------------------------------------
  // CLOSED happy path
  // ---------------------------------------------------------------
  it('runs the operation and returns its result when storage reports CLOSED', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue(CLOSED_RESULT);
    const op = jest.fn<Promise<string>, []>().mockResolvedValue('ok');

    await expect(service.execute(op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(storage.recordProbeSuccess).not.toHaveBeenCalled();
    expect(storage.recordFailure).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // OPEN short-circuits
  // ---------------------------------------------------------------
  it('throws CircuitOpenException WITHOUT calling the operation when storage reports OPEN', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue({
      state: CircuitState.OPEN,
      acquiredProbe: false,
      retryAfterMs: 30_000,
    });
    const op = jest.fn<Promise<string>, []>().mockResolvedValue('would-have-run');

    const caught = await service.execute(op).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(CircuitOpenException);
    expect(op).not.toHaveBeenCalled();
  });

  it('CircuitOpenException carries retryAfterSeconds derived from retryAfterMs', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue({
      state: CircuitState.OPEN,
      acquiredProbe: false,
      retryAfterMs: 12_400,
    });

    const caught = (await service
      .execute(jest.fn<Promise<string>, []>())
      .catch((e: unknown) => e)) as CircuitOpenException;
    const body = caught.getResponse() as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBe(13); // ceil(12400 / 1000)
  });

  it('treats a probe already in flight (storage masks it as OPEN) as blocked', async () => {
    // The storage's SET-NX gate reports non-probe-holders as OPEN, never as
    // HALF_OPEN — so "probe in flight" reaches the service as state=OPEN.
    storage.evaluateAndAcquireProbe.mockResolvedValue({
      state: CircuitState.OPEN,
      acquiredProbe: false,
      retryAfterMs: 30_000,
    });
    const op = jest.fn<Promise<string>, []>().mockResolvedValue('x');

    await expect(service.execute(op)).rejects.toBeInstanceOf(CircuitOpenException);
    expect(op).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // HALF_OPEN probe-holder
  // ---------------------------------------------------------------
  it('runs the probe and records success when storage grants HALF_OPEN + acquiredProbe', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue({
      state: CircuitState.HALF_OPEN,
      acquiredProbe: true,
      retryAfterMs: 0,
    });
    const op = jest.fn<Promise<string>, []>().mockResolvedValue('probe-ok');

    await expect(service.execute(op)).resolves.toBe('probe-ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(storage.recordProbeSuccess).toHaveBeenCalledTimes(1);
    expect(storage.recordFailure).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Failure recording
  // ---------------------------------------------------------------
  it('records a failure (threshold, window, openDuration) and rethrows when the operation fails in CLOSED', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue(CLOSED_RESULT);
    storage.recordFailure.mockResolvedValue(CircuitState.CLOSED);
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('boom'));

    const caught = await service.execute(op).catch((e: unknown) => e);
    expect((caught as Error).message).toBe('boom');
    expect(storage.recordFailure).toHaveBeenCalledWith(THRESHOLD, WINDOW_MS, OPEN_MS);
  });

  it('records a failure and rethrows when the HALF_OPEN probe operation fails', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue({
      state: CircuitState.HALF_OPEN,
      acquiredProbe: true,
      retryAfterMs: 0,
    });
    storage.recordFailure.mockResolvedValue(CircuitState.OPEN);
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('still down'));

    const caught = await service.execute(op).catch((e: unknown) => e);
    expect((caught as Error).message).toBe('still down');
    expect(storage.recordFailure).toHaveBeenCalledTimes(1);
    expect(storage.recordProbeSuccess).not.toHaveBeenCalled();
  });

  it('still rethrows the original operation error if recording the failure itself fails (fail-open)', async () => {
    storage.evaluateAndAcquireProbe.mockResolvedValue(CLOSED_RESULT);
    storage.recordFailure.mockRejectedValue(new Error('redis down'));
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('original'));

    const caught = await service.execute(op).catch((e: unknown) => e);
    expect((caught as Error).message).toBe('original');
  });

  // ---------------------------------------------------------------
  // Fail-open when Redis is unreachable on evaluate
  // ---------------------------------------------------------------
  it('fails open — runs the operation directly when evaluateAndAcquireProbe throws', async () => {
    storage.evaluateAndAcquireProbe.mockRejectedValue(new Error('Redis is unreachable'));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const op = jest.fn<Promise<string>, []>().mockResolvedValue('ran-anyway');

    await expect(service.execute(op)).resolves.toBe('ran-anyway');
    expect(op).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('circuit_storage_failed');
    expect(line).toContain('action=fail_open');
  });

  // ---------------------------------------------------------------
  // Log message shapes preserved
  // ---------------------------------------------------------------
  describe('log message shapes', () => {
    it('logs circuit_blocked state=OPEN retry_after_seconds=N on a blocked call', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      storage.evaluateAndAcquireProbe.mockResolvedValue({
        state: CircuitState.OPEN,
        acquiredProbe: false,
        retryAfterMs: 5_000,
      });

      await service.execute(jest.fn<Promise<string>, []>()).catch(() => undefined);
      expect(warnSpy).toHaveBeenCalledWith('circuit_blocked state=OPEN retry_after_seconds=5');
    });

    it('logs circuit_transition from=CLOSED to=OPEN reason=threshold_exceeded when a CLOSED failure trips the circuit', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      storage.evaluateAndAcquireProbe.mockResolvedValue(CLOSED_RESULT);
      storage.recordFailure.mockResolvedValue(CircuitState.OPEN);

      await service
        .execute(jest.fn<Promise<string>, []>().mockRejectedValue(new Error('x')))
        .catch(() => undefined);

      expect(logSpy).toHaveBeenCalledWith(
        'circuit_transition from=CLOSED to=OPEN reason=threshold_exceeded',
      );
    });

    it('logs the HALF_OPEN promotion and the probe_success close', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      storage.evaluateAndAcquireProbe.mockResolvedValue({
        state: CircuitState.HALF_OPEN,
        acquiredProbe: true,
        retryAfterMs: 0,
      });

      await service.execute(jest.fn<Promise<string>, []>().mockResolvedValue('ok'));

      expect(logSpy).toHaveBeenCalledWith(
        'circuit_transition from=OPEN to=HALF_OPEN reason=cooldown_elapsed',
      );
      expect(logSpy).toHaveBeenCalledWith(
        'circuit_transition from=HALF_OPEN to=CLOSED reason=probe_success',
      );
    });

    it('logs reason=probe_failure when the HALF_OPEN probe fails and trips back to OPEN', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      storage.evaluateAndAcquireProbe.mockResolvedValue({
        state: CircuitState.HALF_OPEN,
        acquiredProbe: true,
        retryAfterMs: 0,
      });
      storage.recordFailure.mockResolvedValue(CircuitState.OPEN);

      await service
        .execute(jest.fn<Promise<string>, []>().mockRejectedValue(new Error('down')))
        .catch(() => undefined);

      expect(logSpy).toHaveBeenCalledWith(
        'circuit_transition from=HALF_OPEN to=OPEN reason=probe_failure',
      );
    });
  });

  // ---------------------------------------------------------------
  // getSnapshot
  // ---------------------------------------------------------------
  describe('getSnapshot', () => {
    it('maps the storage snapshot into a CircuitSnapshot (OPEN with willCloseAt)', async () => {
      const openedAtMs = 1_000_000;
      const lastFailureAtMs = 1_000_500;
      storage.readSnapshot.mockResolvedValue({
        state: CircuitState.OPEN,
        failureCount: 3,
        openedAtMs,
        lastFailureAtMs,
      });

      const snap = await service.getSnapshot();
      expect(snap.state).toBe(CircuitState.OPEN);
      expect(snap.failureCount).toBe(3);
      expect(snap.openedAt).toEqual(new Date(openedAtMs));
      expect(snap.lastFailureAt).toEqual(new Date(lastFailureAtMs));
      expect(snap.willCloseAt).toEqual(new Date(openedAtMs + OPEN_MS));
      expect(storage.readSnapshot).toHaveBeenCalledWith(WINDOW_MS);
    });

    it('returns a safe CLOSED default when Redis read fails', async () => {
      storage.readSnapshot.mockRejectedValue(new Error('redis down'));

      const snap = await service.getSnapshot();
      expect(snap).toEqual({
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureAt: null,
        openedAt: null,
        willCloseAt: null,
      });
    });
  });
});
