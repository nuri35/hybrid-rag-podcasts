import type { RedisService } from '../../redis/redis.service';
import { CircuitState } from '../types/circuit-breaker.types';
import {
  CIRCUIT_KEYS,
  CircuitBreakerRedisStorage,
  EVALUATE_AND_ACQUIRE_PROBE_LUA,
  RECORD_FAILURE_LUA,
  RECORD_PROBE_SUCCESS_LUA,
} from './circuit-breaker-redis.storage';

const THRESHOLD = 5;
const WINDOW_MS = 60_000;
const OPEN_MS = 30_000;
const EXPECTED_TTL_MS = 240_000; // max(60000, 30000) * 4

interface MockRedisService {
  eval: jest.Mock<Promise<unknown>, [string, string[], string[]]>;
}

function makeRedis(): MockRedisService {
  return { eval: jest.fn<Promise<unknown>, [string, string[], string[]]>() };
}

describe('CircuitBreakerRedisStorage', () => {
  let redis: MockRedisService;
  let storage: CircuitBreakerRedisStorage;

  beforeEach(() => {
    redis = makeRedis();
    storage = new CircuitBreakerRedisStorage(redis as unknown as RedisService);
  });

  function lastCall(): [string, string[], string[]] {
    return redis.eval.mock.calls[redis.eval.mock.calls.length - 1];
  }

  // ---------------------------------------------------------------
  // evaluateAndAcquireProbe — invocation shape
  // ---------------------------------------------------------------
  describe('evaluateAndAcquireProbe', () => {
    it('invokes EVAL with the evaluate script, all 5 keys, and ordered args', async () => {
      redis.eval.mockResolvedValueOnce(['CLOSED', 0, 0]);

      await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);

      const [script, keys, args] = lastCall();
      expect(script).toBe(EVALUATE_AND_ACQUIRE_PROBE_LUA);
      expect(keys).toEqual(CIRCUIT_KEYS);
      expect(keys).toHaveLength(5);
      // args: [now, windowMs, openDurationMs, ttlMs]
      expect(args[0]).toMatch(/^\d+$/); // now (ms epoch)
      expect(args[1]).toBe(String(WINDOW_MS));
      expect(args[2]).toBe(String(OPEN_MS));
      expect(args[3]).toBe(String(EXPECTED_TTL_MS));
    });

    it('parses a CLOSED result (no probe, no retry)', async () => {
      redis.eval.mockResolvedValueOnce(['CLOSED', 0, 0]);
      const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
      expect(result).toEqual({ state: CircuitState.CLOSED, acquiredProbe: false, retryAfterMs: 0 });
    });

    it('parses an OPEN result and surfaces retryAfterMs', async () => {
      redis.eval.mockResolvedValueOnce(['OPEN', 0, 5000]);
      const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
      expect(result).toEqual({
        state: CircuitState.OPEN,
        acquiredProbe: false,
        retryAfterMs: 5000,
      });
    });

    it('parses a HALF_OPEN result with the probe acquired', async () => {
      redis.eval.mockResolvedValueOnce(['HALF_OPEN', 1, 0]);
      const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
      expect(result).toEqual({
        state: CircuitState.HALF_OPEN,
        acquiredProbe: true,
        retryAfterMs: 0,
      });
    });

    it('defends against a null Redis return (treats as CLOSED, not blocked)', async () => {
      redis.eval.mockResolvedValueOnce(null);
      const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
      expect(result).toEqual({ state: CircuitState.CLOSED, acquiredProbe: false, retryAfterMs: 0 });
    });

    it('defends against an unknown state string (treats as CLOSED)', async () => {
      redis.eval.mockResolvedValueOnce(['GARBAGE', 0, 0]);
      const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
      expect(result.state).toBe(CircuitState.CLOSED);
    });
  });

  // ---------------------------------------------------------------
  // recordFailure — invocation shape + state parsing
  // ---------------------------------------------------------------
  describe('recordFailure', () => {
    it('invokes EVAL with the record-failure script, 5 keys, and ordered args incl. a unique member', async () => {
      redis.eval.mockResolvedValueOnce('CLOSED');

      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);

      const [script, keys, args] = lastCall();
      expect(script).toBe(RECORD_FAILURE_LUA);
      expect(keys).toEqual(CIRCUIT_KEYS);
      // args: [now, windowMs, failureThreshold, openDurationMs, member, ttlMs]
      expect(args[0]).toMatch(/^\d+$/);
      expect(args[1]).toBe(String(WINDOW_MS));
      expect(args[2]).toBe(String(THRESHOLD));
      expect(args[3]).toBe(String(OPEN_MS));
      expect(args[4]).toMatch(/^\d+-/); // member = `${now}-${uuid}`, sorted-set-unique
      expect(args[5]).toBe(String(EXPECTED_TTL_MS));
    });

    it('returns OPEN when Redis reports the circuit tripped (covers HALF_OPEN→OPEN and threshold→OPEN)', async () => {
      redis.eval.mockResolvedValueOnce('OPEN');
      const state = await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
      expect(state).toBe(CircuitState.OPEN);
    });

    it('returns CLOSED when still below threshold', async () => {
      redis.eval.mockResolvedValueOnce('CLOSED');
      const state = await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
      expect(state).toBe(CircuitState.CLOSED);
    });

    it('defends against a null Redis return (treats as CLOSED)', async () => {
      redis.eval.mockResolvedValueOnce(null);
      const state = await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
      expect(state).toBe(CircuitState.CLOSED);
    });

    it('generates a distinct member on each call (no sorted-set collisions)', async () => {
      redis.eval.mockResolvedValue('CLOSED');
      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
      const member1 = redis.eval.mock.calls[0][2][4];
      const member2 = redis.eval.mock.calls[1][2][4];
      expect(member1).not.toBe(member2);
    });
  });

  // ---------------------------------------------------------------
  // recordProbeSuccess
  // ---------------------------------------------------------------
  describe('recordProbeSuccess', () => {
    it('invokes EVAL with the probe-success script, all 5 keys, and no args (full DEL reset)', async () => {
      redis.eval.mockResolvedValueOnce('CLOSED');
      await storage.recordProbeSuccess();

      const [script, keys, args] = lastCall();
      expect(script).toBe(RECORD_PROBE_SUCCESS_LUA);
      expect(keys).toEqual(CIRCUIT_KEYS);
      expect(args).toEqual([]);
    });

    it('resolves without throwing when the circuit is already CLOSED (no-op path)', async () => {
      redis.eval.mockResolvedValueOnce('CLOSED');
      await expect(storage.recordProbeSuccess()).resolves.toBeUndefined();
    });
  });
});
