import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RetryExhaustedException } from '../exceptions/retry-exhausted.exception';
import { RetryPolicyService } from './retry-policy.service';

interface ConfigOverrides {
  LLM_RETRY_MAX_ATTEMPTS?: number;
  LLM_RETRY_INITIAL_DELAY_MS?: number;
  LLM_RETRY_MAX_DELAY_MS?: number;
  LLM_RETRY_BACKOFF_FACTOR?: number;
  LLM_RETRY_JITTER_FACTOR?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    LLM_RETRY_MAX_ATTEMPTS: 3,
    LLM_RETRY_INITIAL_DELAY_MS: 500,
    LLM_RETRY_MAX_DELAY_MS: 10_000,
    LLM_RETRY_BACKOFF_FACTOR: 2,
    LLM_RETRY_JITTER_FACTOR: 0.3,
    ...overrides,
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService;
}

async function buildService(overrides: ConfigOverrides = {}): Promise<RetryPolicyService> {
  const moduleRef = await Test.createTestingModule({
    providers: [RetryPolicyService, { provide: ConfigService, useValue: makeConfig(overrides) }],
  }).compile();
  return moduleRef.get(RetryPolicyService);
}

/** Make an Error carrying an HTTP status on any of the supported shapes. */
function httpError(status: number, message = 'simulated'): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function nodeError(code: string, message = 'simulated'): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

describe('RetryPolicyService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------
  // isRetryable
  // ---------------------------------------------------------------
  describe('isRetryable', () => {
    it('returns true for HTTP 429 (rate limit)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(429))).toBe(true);
    });

    it('returns true for HTTP 503 (service unavailable)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(503))).toBe(true);
    });

    it('returns true for HTTP 500 (server error, treated as transient)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(500))).toBe(true);
    });

    it('returns false for HTTP 400 (bad request — non-retryable input)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(400))).toBe(false);
    });

    it('returns false for HTTP 401 (auth — non-retryable)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(401))).toBe(false);
    });

    it('returns false for HTTP 404 (not found — non-retryable)', async () => {
      const service = await buildService();
      expect(service.isRetryable(httpError(404))).toBe(false);
    });

    it('returns true for Node ETIMEDOUT', async () => {
      const service = await buildService();
      expect(service.isRetryable(nodeError('ETIMEDOUT'))).toBe(true);
    });

    it('returns true for Node ECONNRESET', async () => {
      const service = await buildService();
      expect(service.isRetryable(nodeError('ECONNRESET'))).toBe(true);
    });

    it('returns true for message matching /rate.?limit/i (last-resort pattern)', async () => {
      const service = await buildService();
      expect(service.isRetryable(new Error('Rate limit exceeded'))).toBe(true);
      expect(service.isRetryable(new Error('hit a ratelimit'))).toBe(true);
    });

    it('returns true for message matching /timeout/i', async () => {
      const service = await buildService();
      expect(service.isRetryable(new Error('Request timeout after 30000ms'))).toBe(true);
    });

    it('returns false for a plain Error with an unrelated message', async () => {
      const service = await buildService();
      expect(service.isRetryable(new Error('something custom went wrong'))).toBe(false);
    });

    it('returns false for non-Error values (string, number, null)', async () => {
      const service = await buildService();
      expect(service.isRetryable('a string')).toBe(false);
      expect(service.isRetryable(42)).toBe(false);
      expect(service.isRetryable(null)).toBe(false);
    });

    it('extracts HTTP status from `response.status` shape (LangChain wrappers)', async () => {
      const service = await buildService();
      const err = new Error('wrapped') as Error & { response?: { status: number } };
      err.response = { status: 503 };
      expect(service.isRetryable(err)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // execute — happy paths
  // ---------------------------------------------------------------
  describe('execute', () => {
    it('returns a success result on first attempt without retrying', async () => {
      const service = await buildService();
      const op = jest.fn().mockResolvedValue('ok');

      const result = await service.execute(op);

      expect(result.success).toBe(true);
      expect(result.result).toBe('ok');
      expect(result.attempts).toBe(1);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('retries once on a retryable error then succeeds on the second attempt', async () => {
      jest.useFakeTimers();
      const service = await buildService({ LLM_RETRY_INITIAL_DELAY_MS: 100 });
      const op = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce('second-try');

      const promise = service.execute(op);
      // Let the first attempt fail, then advance past the backoff so the
      // second attempt fires.
      await jest.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('second-try');
      expect(result.attempts).toBe(2);
      expect(op).toHaveBeenCalledTimes(2);
    });

    it('throws RetryExhaustedException after maxAttempts retryable failures', async () => {
      jest.useFakeTimers();
      const service = await buildService({
        LLM_RETRY_MAX_ATTEMPTS: 3,
        LLM_RETRY_INITIAL_DELAY_MS: 50,
      });
      const op = jest.fn<Promise<string>, []>().mockRejectedValue(httpError(503));

      const promise = service.execute(op);
      const caughtPromise = promise.catch((e: unknown) => e);
      // Advance enough to walk through 50 + 100 ms backoffs plus headroom.
      await jest.advanceTimersByTimeAsync(1000);
      const caught = await caughtPromise;

      expect(caught).toBeInstanceOf(RetryExhaustedException);
      expect((caught as RetryExhaustedException).attempts).toBe(3);
      expect((caught as RetryExhaustedException).lastError).toBeInstanceOf(Error);
      expect(op).toHaveBeenCalledTimes(3);
    });

    it('throws immediately on a non-retryable error (no second attempt)', async () => {
      const service = await buildService();
      const badRequest = httpError(400, 'bad input');
      const op = jest.fn<Promise<string>, []>().mockRejectedValue(badRequest);

      const caught = await service.execute(op).catch((e: unknown) => e);

      expect(caught).toBe(badRequest);
      expect(caught).not.toBeInstanceOf(RetryExhaustedException);
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('grows the backoff exponentially between retries (verified via setTimeout spy)', async () => {
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const service = await buildService({
        LLM_RETRY_MAX_ATTEMPTS: 4,
        LLM_RETRY_INITIAL_DELAY_MS: 100,
        LLM_RETRY_BACKOFF_FACTOR: 2,
        LLM_RETRY_JITTER_FACTOR: 0, // disable jitter for deterministic comparison
      });
      const op = jest.fn<Promise<string>, []>().mockRejectedValue(httpError(503));

      const promise = service.execute(op);
      const caughtPromise = promise.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(2000);
      await caughtPromise;

      // execute() retries between attempts 1→2, 2→3, 3→4 (3 sleeps total).
      // Filter setTimeout calls to those scheduled by the service's sleep
      // (numeric ms args). Other timers (jest internals) may also register.
      const sleepDelays = setTimeoutSpy.mock.calls
        .map((args) => args[1])
        .filter((ms): ms is number => typeof ms === 'number' && ms >= 100 && ms <= 5000);

      expect(sleepDelays.length).toBeGreaterThanOrEqual(3);
      expect(sleepDelays[0]).toBe(100); // initial
      expect(sleepDelays[1]).toBe(200); // ×2
      expect(sleepDelays[2]).toBe(400); // ×2 again

      setTimeoutSpy.mockRestore();
    });

    it('caps the backoff at maxDelayMs', async () => {
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const service = await buildService({
        LLM_RETRY_MAX_ATTEMPTS: 5,
        LLM_RETRY_INITIAL_DELAY_MS: 1000,
        LLM_RETRY_BACKOFF_FACTOR: 10,
        LLM_RETRY_MAX_DELAY_MS: 3000, // cap before the third retry would
        LLM_RETRY_JITTER_FACTOR: 0,
      });
      const op = jest.fn<Promise<string>, []>().mockRejectedValue(httpError(503));

      const promise = service.execute(op);
      const caughtPromise = promise.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(20_000);
      await caughtPromise;

      const sleepDelays = setTimeoutSpy.mock.calls
        .map((args) => args[1])
        .filter((ms): ms is number => typeof ms === 'number' && ms >= 1000 && ms <= 50_000);

      // Sequence is computed with currentDelay then min(currentDelay*10, 3000):
      //   sleep#1 = 1000, then currentDelay = min(10000, 3000) = 3000
      //   sleep#2 = 3000, then currentDelay = min(30000, 3000) = 3000
      //   sleep#3 = 3000, then currentDelay = min(30000, 3000) = 3000
      //   sleep#4 = 3000  (4 sleeps because 5 attempts → 4 inter-attempt waits)
      expect(sleepDelays.length).toBeGreaterThanOrEqual(4);
      expect(sleepDelays.slice(0, 4)).toEqual([1000, 3000, 3000, 3000]);
      // Critically: no sleep ever exceeds the cap.
      sleepDelays.forEach((ms) => expect(ms).toBeLessThanOrEqual(3000));

      setTimeoutSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------
  // applyJitter (white-box) — statistical distribution
  // ---------------------------------------------------------------
  describe('applyJitter (private helper)', () => {
    it('keeps results within the ±factor envelope across 200 samples', async () => {
      const service = await buildService();
      const applyJitter = (
        service as unknown as { applyJitter: (delayMs: number, factor: number) => number }
      ).applyJitter.bind(service);

      const base = 1000;
      const factor = 0.3;
      const lower = Math.round(base * (1 - factor));
      const upper = Math.round(base * (1 + factor));

      let minObserved = Infinity;
      let maxObserved = -Infinity;
      for (let i = 0; i < 200; i++) {
        const v = applyJitter(base, factor);
        expect(v).toBeGreaterThanOrEqual(lower);
        expect(v).toBeLessThanOrEqual(upper);
        if (v < minObserved) minObserved = v;
        if (v > maxObserved) maxObserved = v;
      }

      // 200 samples should land in at least half of the band each direction.
      // This is a soft check — a degenerate Math.random() that always
      // returned 0.5 would produce a single value and trip the assertion.
      expect(maxObserved - minObserved).toBeGreaterThan((upper - lower) * 0.5);
    });

    it('returns 0 when the jittered offset would be negative', async () => {
      const service = await buildService();
      const applyJitter = (
        service as unknown as { applyJitter: (delayMs: number, factor: number) => number }
      ).applyJitter.bind(service);

      // factor=2 with delayMs=10 → range ±20. Min possible = 10 - 20 = -10,
      // clamped to 0. Run many samples to hit the negative-offset path.
      let sawZero = false;
      for (let i = 0; i < 100; i++) {
        const v = applyJitter(10, 2);
        expect(v).toBeGreaterThanOrEqual(0);
        if (v === 0) sawZero = true;
      }
      expect(sawZero).toBe(true);
    });
  });
});
