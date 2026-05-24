import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import { CircuitState } from '../types/circuit-breaker.types';
import { CircuitBreakerService } from './circuit-breaker.service';

interface ConfigOverrides {
  LLM_CIRCUIT_FAILURE_THRESHOLD?: number;
  LLM_CIRCUIT_WINDOW_MS?: number;
  LLM_CIRCUIT_OPEN_DURATION_MS?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    LLM_CIRCUIT_FAILURE_THRESHOLD: 5,
    LLM_CIRCUIT_WINDOW_MS: 60_000,
    LLM_CIRCUIT_OPEN_DURATION_MS: 30_000,
    ...overrides,
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService;
}

async function buildService(overrides: ConfigOverrides = {}): Promise<CircuitBreakerService> {
  const moduleRef = await Test.createTestingModule({
    providers: [CircuitBreakerService, { provide: ConfigService, useValue: makeConfig(overrides) }],
  }).compile();
  return moduleRef.get(CircuitBreakerService);
}

/**
 * Run N failing operations through `execute` to drive the circuit toward
 * its threshold. Returns the count actually run (which equals N unless
 * the circuit tripped open mid-loop and rejected later calls).
 */
async function driveFailures(
  service: CircuitBreakerService,
  count: number,
  error: Error = new Error('upstream down'),
): Promise<number> {
  let ran = 0;
  for (let i = 0; i < count; i++) {
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(error);
    await service.execute(op).catch(() => undefined);
    ran++;
  }
  return ran;
}

describe('CircuitBreakerService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------
  // Initial state + happy path
  // ---------------------------------------------------------------
  describe('initial state', () => {
    it('starts in CLOSED state with zero failures', async () => {
      const service = await buildService();
      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.CLOSED);
      expect(snap.failureCount).toBe(0);
      expect(snap.lastFailureAt).toBeNull();
      expect(snap.openedAt).toBeNull();
      expect(snap.willCloseAt).toBeNull();
    });

    it('successful execution keeps the circuit CLOSED', async () => {
      const service = await buildService();
      const op = jest.fn<Promise<string>, []>().mockResolvedValue('ok');

      const result = await service.execute(op);
      expect(result).toBe('ok');
      expect(service.getSnapshot().state).toBe(CircuitState.CLOSED);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('failures below threshold keep the circuit CLOSED and increment the counter', async () => {
      const service = await buildService({ LLM_CIRCUIT_FAILURE_THRESHOLD: 5 });
      await driveFailures(service, 3);

      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.CLOSED);
      expect(snap.failureCount).toBe(3);
      expect(snap.lastFailureAt).toBeInstanceOf(Date);
    });
  });

  // ---------------------------------------------------------------
  // Tripping CLOSED → OPEN
  // ---------------------------------------------------------------
  describe('CLOSED → OPEN', () => {
    it('trips to OPEN when failureThreshold is reached', async () => {
      jest.useFakeTimers();
      const service = await buildService({ LLM_CIRCUIT_FAILURE_THRESHOLD: 3 });
      await driveFailures(service, 3);

      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.OPEN);
      expect(snap.openedAt).toBeInstanceOf(Date);
      expect(snap.willCloseAt).toBeInstanceOf(Date);
    });

    it('while OPEN, execute throws CircuitOpenException WITHOUT calling the operation', async () => {
      jest.useFakeTimers();
      const service = await buildService({ LLM_CIRCUIT_FAILURE_THRESHOLD: 2 });
      await driveFailures(service, 2);
      expect(service.getSnapshot().state).toBe(CircuitState.OPEN);

      const op = jest.fn<Promise<string>, []>().mockResolvedValue('would-have-been-ok');
      const caught = await service.execute(op).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CircuitOpenException);
      expect(op).not.toHaveBeenCalled();
    });

    it('CircuitOpenException carries a retryAfterSeconds hint', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 1,
        LLM_CIRCUIT_OPEN_DURATION_MS: 30_000,
      });
      await driveFailures(service, 1);

      const caught = (await service.execute(jest.fn()).catch((e: unknown) => e)) as
        | CircuitOpenException
        | undefined;
      expect(caught).toBeInstanceOf(CircuitOpenException);

      // The response body contains retryAfterSeconds — read it from the
      // HttpException's getResponse() envelope.
      const body = caught!.getResponse() as { retryAfterSeconds?: number };
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(30);
    });
  });

  // ---------------------------------------------------------------
  // OPEN → HALF_OPEN cool-down + probe behaviour
  // ---------------------------------------------------------------
  describe('OPEN → HALF_OPEN → CLOSED / OPEN', () => {
    it('transitions to HALF_OPEN once openDurationMs elapses on the next execute', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 1,
        LLM_CIRCUIT_OPEN_DURATION_MS: 1000,
      });
      await driveFailures(service, 1);
      expect(service.getSnapshot().state).toBe(CircuitState.OPEN);

      // Advance past the cool-down so the next execute promotes to HALF_OPEN.
      jest.advanceTimersByTime(1500);
      const probeOp = jest.fn<Promise<string>, []>().mockResolvedValue('probe-ok');
      const result = await service.execute(probeOp);

      expect(result).toBe('probe-ok');
      // HALF_OPEN success transitions to CLOSED.
      expect(service.getSnapshot().state).toBe(CircuitState.CLOSED);
      expect(probeOp).toHaveBeenCalledTimes(1);
    });

    it('HALF_OPEN failure transitions back to OPEN and re-arms the cool-down', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 1,
        LLM_CIRCUIT_OPEN_DURATION_MS: 1000,
      });
      await driveFailures(service, 1);
      jest.advanceTimersByTime(1500);

      const probeOp = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('still down'));
      const caught = await service.execute(probeOp).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('still down');
      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.OPEN);
      expect(snap.openedAt).toBeInstanceOf(Date);
    });

    it('successful HALF_OPEN probe resets the failure window (snapshot.failureCount = 0)', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 2,
        LLM_CIRCUIT_OPEN_DURATION_MS: 1000,
      });
      await driveFailures(service, 2);
      jest.advanceTimersByTime(1500);
      await service.execute(jest.fn<Promise<string>, []>().mockResolvedValue('ok'));

      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.CLOSED);
      expect(snap.failureCount).toBe(0);
    });

    it('rejects a concurrent HALF_OPEN probe — second caller gets CircuitOpenException', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 1,
        LLM_CIRCUIT_OPEN_DURATION_MS: 1000,
      });
      await driveFailures(service, 1);
      jest.advanceTimersByTime(1500);

      // First probe: never resolves so we can observe the in-flight state.
      const slowOp = jest
        .fn<Promise<string>, []>()
        .mockImplementation(() => new Promise(() => undefined));
      const probe1 = service.execute(slowOp);
      probe1.catch(() => undefined); // suppress unhandled rejection on test end

      // Second caller arrives while probe1 is still in flight.
      const op2 = jest.fn<Promise<string>, []>().mockResolvedValue('should-not-run');
      const caught = await service.execute(op2).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CircuitOpenException);
      expect(op2).not.toHaveBeenCalled();
      expect(slowOp).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------
  // Rolling window semantics
  // ---------------------------------------------------------------
  describe('rolling failure window', () => {
    it('prunes failures older than windowMs', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 10,
        LLM_CIRCUIT_WINDOW_MS: 10_000,
      });

      // 3 failures at t=0
      await driveFailures(service, 3);
      expect(service.getSnapshot().failureCount).toBe(3);

      // Move past the window — old failures should be pruned on next read.
      jest.advanceTimersByTime(11_000);
      expect(service.getSnapshot().failureCount).toBe(0);
      // State stays CLOSED (we never tripped).
      expect(service.getSnapshot().state).toBe(CircuitState.CLOSED);
    });

    it('failures spread beyond windowMs do not trip the circuit', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 5,
        LLM_CIRCUIT_WINDOW_MS: 10_000,
      });

      // 3 failures, wait > window, 3 more failures. Effective count after
      // the second batch is 3, not 6 — first batch is pruned.
      await driveFailures(service, 3);
      jest.advanceTimersByTime(11_000);
      await driveFailures(service, 3);

      const snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.CLOSED);
      expect(snap.failureCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------
  // Snapshot accuracy at every transition
  // ---------------------------------------------------------------
  describe('getSnapshot', () => {
    it('reports the full lifecycle CLOSED → OPEN → HALF_OPEN → CLOSED accurately', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_CIRCUIT_FAILURE_THRESHOLD: 2,
        LLM_CIRCUIT_OPEN_DURATION_MS: 1000,
      });

      // Phase 1: CLOSED
      expect(service.getSnapshot().state).toBe(CircuitState.CLOSED);

      // Phase 2: trip to OPEN
      await driveFailures(service, 2);
      let snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.OPEN);
      expect(snap.openedAt).toBeInstanceOf(Date);
      expect(snap.willCloseAt).toBeInstanceOf(Date);
      expect(snap.willCloseAt!.getTime() - snap.openedAt!.getTime()).toBe(1000);

      // Phase 3: cool-down + HALF_OPEN probe success → CLOSED
      jest.advanceTimersByTime(1500);
      await service.execute(jest.fn<Promise<string>, []>().mockResolvedValue('ok'));
      snap = service.getSnapshot();
      expect(snap.state).toBe(CircuitState.CLOSED);
      expect(snap.openedAt).toBeNull();
      expect(snap.willCloseAt).toBeNull();
      expect(snap.failureCount).toBe(0);
    });
  });
});
