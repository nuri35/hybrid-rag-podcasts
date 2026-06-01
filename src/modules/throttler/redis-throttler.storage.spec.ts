import { Logger } from '@nestjs/common';
import type { RedisService } from '../redis/redis.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * RedisService is mocked — these tests exercise only the storage's own
 * logic (key construction, count→record mapping, seconds conversion,
 * fail-open). The Lua INCR+EXPIRE atomicity is a Redis concern; from the
 * storage's side we assert the script SHAPE handed to `eval` (that it
 * guards EXPIRE behind `current == 1`).
 */
interface MockRedisService {
  eval: jest.Mock<Promise<unknown>, [string, string[], string[]]>;
  pttl: jest.Mock<Promise<number>, [string]>;
}

function makeMockRedis(): MockRedisService {
  return {
    eval: jest.fn<Promise<unknown>, [string, string[], string[]]>(),
    pttl: jest.fn<Promise<number>, [string]>(),
  };
}

describe('RedisThrottlerStorage', () => {
  let redis: MockRedisService;
  let storage: RedisThrottlerStorage;

  // Default-throttler window: 60_000 ms TTL, limit 30.
  const TTL_MS = 60_000;
  const LIMIT = 30;
  const BLOCK_DURATION = 0;

  beforeEach(() => {
    redis = makeMockRedis();
    storage = new RedisThrottlerStorage(redis as unknown as RedisService);
  });

  /** Typed accessor for the `keys` argument (index 1) of the Nth eval call. */
  function evalKeysOfCall(index: number): string[] {
    return redis.eval.mock.calls[index][1];
  }

  it('returns totalHits=1 with the full TTL (in seconds) on the first call', async () => {
    redis.eval.mockResolvedValueOnce(1);
    redis.pttl.mockResolvedValueOnce(60_000);

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record.totalHits).toBe(1);
    // Seconds, NOT milliseconds — the guard feeds timeToBlockExpire straight
    // into the HTTP Retry-After header, which is defined in seconds.
    expect(record.timeToExpire).toBe(60);
    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
  });

  it('returns totalHits=2 on the second call within the window', async () => {
    redis.eval.mockResolvedValueOnce(2);
    redis.pttl.mockResolvedValueOnce(58_000);

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record.totalHits).toBe(2);
    expect(record.timeToExpire).toBe(58);
    expect(record.isBlocked).toBe(false);
  });

  it('guards EXPIRE behind `current == 1` in the Lua script, with the TTL in seconds', async () => {
    redis.eval.mockResolvedValueOnce(1);
    redis.pttl.mockResolvedValueOnce(60_000);

    await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = redis.eval.mock.calls[0];
    expect(script).toContain('INCR');
    expect(script).toContain('EXPIRE');
    expect(script).toMatch(/current\s*==\s*1/);
    expect(keys).toEqual(['throttle:default:1.2.3.4']);
    // 60_000 ms → 60 s passed to EXPIRE.
    expect(args).toEqual(['60']);
  });

  it('returns isBlocked=true when the count exceeds the limit', async () => {
    redis.eval.mockResolvedValueOnce(LIMIT + 1);
    redis.pttl.mockResolvedValueOnce(45_000);

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record.totalHits).toBe(LIMIT + 1);
    expect(record.isBlocked).toBe(true);
    // When blocked, timeToBlockExpire mirrors the remaining window (seconds).
    expect(record.timeToBlockExpire).toBe(45);
  });

  it('returns isBlocked=false when the count is exactly at the limit', async () => {
    redis.eval.mockResolvedValueOnce(LIMIT);
    redis.pttl.mockResolvedValueOnce(45_000);

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
  });

  it('fails open (zeros, not blocked) and warns when Redis throws', async () => {
    redis.eval.mockRejectedValueOnce(new Error('Redis is unreachable'));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0][0]);
    expect(warnMessage).toContain('throttler_storage_failed');
    expect(warnMessage).toContain('action=fail_open');
    warnSpy.mockRestore();
  });

  it('produces different Redis keys for different throttler names', async () => {
    redis.eval.mockResolvedValue(1);
    redis.pttl.mockResolvedValue(60_000);

    await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');
    await storage.increment('1.2.3.4', TTL_MS, 5, BLOCK_DURATION, 'stream');

    const firstKeys = evalKeysOfCall(0);
    const secondKeys = evalKeysOfCall(1);
    expect(firstKeys).toEqual(['throttle:default:1.2.3.4']);
    expect(secondKeys).toEqual(['throttle:stream:1.2.3.4']);
  });

  it('produces different Redis keys for different IPs', async () => {
    redis.eval.mockResolvedValue(1);
    redis.pttl.mockResolvedValue(60_000);

    await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');
    await storage.increment('5.6.7.8', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    const firstKeys = evalKeysOfCall(0);
    const secondKeys = evalKeysOfCall(1);
    expect(firstKeys).toEqual(['throttle:default:1.2.3.4']);
    expect(secondKeys).toEqual(['throttle:default:5.6.7.8']);
  });

  it('treats a missing/expired TTL (pttl <= 0) as zero remaining time', async () => {
    redis.eval.mockResolvedValueOnce(1);
    redis.pttl.mockResolvedValueOnce(-2); // key has no TTL / does not exist

    const record = await storage.increment('1.2.3.4', TTL_MS, LIMIT, BLOCK_DURATION, 'default');

    expect(record.timeToExpire).toBe(0);
  });
});
