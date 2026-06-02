/**
 * Live-Redis integration tests for the circuit-breaker Lua scripts.
 *
 * The unit spec (circuit-breaker-redis.storage.spec.ts) mocks `eval`, so it
 * never exercises the Lua itself. THIS spec runs the real scripts against a
 * real Redis to prove the atomic state transitions behave correctly:
 * CLOSED→OPEN at threshold, OPEN→HALF_OPEN after cool-down, single-flight
 * probe acquisition, probe-success→CLOSED, probe-failure→OPEN.
 *
 * STATUS: skipped by default — CI does not provision Redis. To run locally:
 *   1. Ensure Redis is up:  docker compose up -d redis   (container hybrid-rag-redis)
 *   2. Change `describe.skip(...)` to `describe(...)` below
 *   3. Run:  npx jest circuit-breaker-redis.storage.integration --runInBand
 *   4. Re-add `.skip` before committing.
 *
 * Uses tiny windows / cool-downs (real wall-clock sleeps) so the lifecycle
 * runs in well under a second.
 */
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../common/config/env.schema';
import { RedisService } from '../../redis/redis.service';
import { CircuitState } from '../types/circuit-breaker.types';
import { CIRCUIT_KEYS, CircuitBreakerRedisStorage } from './circuit-breaker-redis.storage';

const WINDOW_MS = 5_000;
const OPEN_MS = 150;
const THRESHOLD = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeConfig(): ConfigService<Env, true> {
  const values: Partial<Record<keyof Env, unknown>> = {
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: '',
    REDIS_DB: 0,
    REDIS_CONNECTION_TIMEOUT_MS: 5000,
  };
  return { get: (key: keyof Env): unknown => values[key] } as unknown as ConfigService<Env, true>;
}

describe.skip('CircuitBreakerRedisStorage (live Redis)', () => {
  let redisService: RedisService;
  let storage: CircuitBreakerRedisStorage;

  beforeAll(async () => {
    redisService = new RedisService(makeConfig());
    await redisService.onModuleInit();
    storage = new CircuitBreakerRedisStorage(redisService);
  });

  afterAll(async () => {
    await clearCircuit();
    await redisService.onModuleDestroy();
  });

  beforeEach(async () => {
    await clearCircuit();
  });

  async function clearCircuit(): Promise<void> {
    await redisService.eval(
      "redis.call('del', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]) return 1",
      CIRCUIT_KEYS,
      [],
    );
  }

  it('starts CLOSED', async () => {
    const result = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(result.state).toBe(CircuitState.CLOSED);
    expect(result.acquiredProbe).toBe(false);
  });

  it('trips CLOSED → OPEN once the failure threshold is reached', async () => {
    let last = CircuitState.CLOSED;
    for (let i = 0; i < THRESHOLD; i++) {
      last = await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
    }
    expect(last).toBe(CircuitState.OPEN);

    const evalResult = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(evalResult.state).toBe(CircuitState.OPEN);
    expect(evalResult.retryAfterMs).toBeGreaterThan(0);
  });

  it('promotes OPEN → HALF_OPEN after the cool-down and grants exactly one probe', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
    }
    await sleep(OPEN_MS + 50);

    const first = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(first.state).toBe(CircuitState.HALF_OPEN);
    expect(first.acquiredProbe).toBe(true);

    // Second caller within the same probe window must NOT get a probe.
    const second = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(second.acquiredProbe).toBe(false);
    expect(second.state).toBe(CircuitState.OPEN);
  });

  it('probe success resets to CLOSED and clears all keys', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
    }
    await sleep(OPEN_MS + 50);
    const probe = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(probe.acquiredProbe).toBe(true);

    await storage.recordProbeSuccess();

    // Full DEL reset — every circuit key is gone (absence == implicit CLOSED).
    for (const key of CIRCUIT_KEYS) {
      expect(await redisService.exists(key)).toBe(false);
    }

    const after = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(after.state).toBe(CircuitState.CLOSED);
  });

  it('probe failure sends HALF_OPEN → OPEN', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
    }
    await sleep(OPEN_MS + 50);
    const probe = await storage.evaluateAndAcquireProbe(WINDOW_MS, OPEN_MS);
    expect(probe.state).toBe(CircuitState.HALF_OPEN);

    const newState = await storage.recordFailure(THRESHOLD, WINDOW_MS, OPEN_MS);
    expect(newState).toBe(CircuitState.OPEN);
  });
});
