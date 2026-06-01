import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisUnavailableException } from './exceptions/redis-unavailable.exception';
import { RedisService } from './redis.service';
import type { Env } from '../../common/config/env.schema';

/**
 * Mock the entire ioredis module. Every `new Redis(...)` call returns the
 * same shared mock instance, so tests can drive behaviour via
 * `mockRedis.ping.mockResolvedValueOnce(...)` etc. The shared instance
 * survives across tests in a file; `jest.clearAllMocks()` in beforeEach
 * resets call counts but does not replace return-value queues — those are
 * applied with `mockResolvedValueOnce`/`mockRejectedValueOnce` per test.
 */
jest.mock('ioredis', () => {
  const mockRedis = {
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
    exists: jest.fn(),
    pttl: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  };
  return jest.fn(() => mockRedis);
});

interface MockRedis {
  connect: jest.Mock;
  ping: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
  exists: jest.Mock;
  pttl: jest.Mock;
  quit: jest.Mock;
  on: jest.Mock;
}

function getMockRedis(): MockRedis {
  // The mocked default export is a jest.fn() returning the shared instance.
  const RedisMock = Redis as unknown as jest.Mock;
  return RedisMock.mock.results[0].value as MockRedis;
}

function makeConfigService(): ConfigService<Env, true> {
  const values: Partial<Record<keyof Env, unknown>> = {
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: '',
    REDIS_DB: 0,
    REDIS_CONNECTION_TIMEOUT_MS: 5000,
  };
  return {
    get: jest.fn((key: keyof Env) => values[key]),
  } as unknown as ConfigService<Env, true>;
}

describe('RedisService', () => {
  let service: RedisService;
  let mockRedis: MockRedis;

  beforeEach(() => {
    (Redis as unknown as jest.Mock).mockClear();
    service = new RedisService(makeConfigService());
    mockRedis = getMockRedis();
    // Clear call counts per-test but keep the shared instance.
    Object.values(mockRedis).forEach((m) => {
      if (typeof (m as jest.Mock).mockReset === 'function') (m as jest.Mock).mockReset();
    });
    // quit() is invoked in onModuleDestroy at teardown; keep the resolved default.
    mockRedis.quit.mockResolvedValue('OK');
  });

  describe('ping', () => {
    it('returns PONG on success', async () => {
      mockRedis.ping.mockResolvedValueOnce('PONG');
      const result = await service.ping();
      expect(result).toBe('PONG');
      expect(mockRedis.ping).toHaveBeenCalledTimes(1);
    });

    it('wraps ioredis errors in RedisUnavailableException', async () => {
      const originalError = new Error('ECONNREFUSED');
      mockRedis.ping.mockRejectedValueOnce(originalError);

      const caught = await service.ping().catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RedisUnavailableException);
      expect((caught as RedisUnavailableException).message).toContain("'ping'");
      expect((caught as RedisUnavailableException).cause).toBe(originalError);
    });
  });

  describe('isHealthy', () => {
    it('returns true when ping resolves PONG', async () => {
      mockRedis.ping.mockResolvedValueOnce('PONG');
      await expect(service.isHealthy()).resolves.toBe(true);
    });

    it('returns false when ping rejects (never throws)', async () => {
      mockRedis.ping.mockRejectedValueOnce(new Error('disconnected'));
      await expect(service.isHealthy()).resolves.toBe(false);
    });

    it('returns false when ping resolves with non-PONG value', async () => {
      mockRedis.ping.mockResolvedValueOnce('not-pong');
      await expect(service.isHealthy()).resolves.toBe(false);
    });
  });

  describe('setNX', () => {
    it('returns true when Redis confirms the SET-NX wrote the key', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const result = await service.setNX('lock:k', 'owner-1', 60);
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('lock:k', 'owner-1', 'EX', 60, 'NX');
    });

    it('returns false when the key already existed (Redis returns null)', async () => {
      mockRedis.set.mockResolvedValueOnce(null);
      const result = await service.setNX('lock:k', 'owner-1', 60);
      expect(result).toBe(false);
    });

    it('wraps ioredis errors in RedisUnavailableException', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('disconnected'));
      const caught = await service.setNX('lock:k', 'owner-1', 60).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RedisUnavailableException);
    });
  });

  describe('get', () => {
    it('returns null for missing keys', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      await expect(service.get('missing')).resolves.toBeNull();
    });

    it('returns string value for existing keys', async () => {
      mockRedis.get.mockResolvedValueOnce('payload');
      await expect(service.get('key')).resolves.toBe('payload');
    });

    it('throws RedisUnavailableException when Redis is down', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('disconnected'));
      const caught = await service.get('k').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RedisUnavailableException);
      expect((caught as RedisUnavailableException).message).toContain("'get k'");
    });
  });

  describe('set (with optional TTL)', () => {
    it('uses SET key value EX ttl when ttlSeconds provided', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      await service.set('k', 'v', 120);
      expect(mockRedis.set).toHaveBeenCalledWith('k', 'v', 'EX', 120);
    });

    it('uses SET key value (no TTL) when ttlSeconds omitted', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      await service.set('k', 'v');
      expect(mockRedis.set).toHaveBeenCalledWith('k', 'v');
    });
  });

  describe('exists', () => {
    it('returns true when Redis EXISTS reports 1', async () => {
      mockRedis.exists.mockResolvedValueOnce(1);
      await expect(service.exists('k')).resolves.toBe(true);
    });

    it('returns false when Redis EXISTS reports 0', async () => {
      mockRedis.exists.mockResolvedValueOnce(0);
      await expect(service.exists('k')).resolves.toBe(false);
    });
  });

  describe('eval', () => {
    it('forwards keys and args to ioredis eval call', async () => {
      mockRedis.eval.mockResolvedValueOnce(1);
      const result = await service.eval('return 1', ['k1', 'k2'], ['a1']);
      expect(result).toBe(1);
      expect(mockRedis.eval).toHaveBeenCalledWith('return 1', 2, 'k1', 'k2', 'a1');
    });

    it('wraps ioredis errors in RedisUnavailableException', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('script error'));
      const caught = await service.eval('return 1', [], []).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RedisUnavailableException);
    });
  });

  describe('pttl', () => {
    it('returns the remaining TTL in milliseconds from ioredis', async () => {
      mockRedis.pttl.mockResolvedValueOnce(42_000);
      const result = await service.pttl('throttle:default:1.2.3.4');
      expect(result).toBe(42_000);
      expect(mockRedis.pttl).toHaveBeenCalledWith('throttle:default:1.2.3.4');
    });

    it('wraps ioredis errors in RedisUnavailableException', async () => {
      mockRedis.pttl.mockRejectedValueOnce(new Error('disconnected'));
      const caught = await service.pttl('k').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RedisUnavailableException);
      expect((caught as RedisUnavailableException).message).toContain("'pttl k'");
    });
  });

  describe('lifecycle hooks', () => {
    it('onModuleInit logs success on PONG and does not throw', async () => {
      mockRedis.ping.mockResolvedValueOnce('PONG');
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('onModuleInit swallows ping errors so the service stays up', async () => {
      mockRedis.ping.mockRejectedValueOnce(new Error('disconnected'));
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('onModuleDestroy calls quit and swallows any error', async () => {
      mockRedis.quit.mockRejectedValueOnce(new Error('already closed'));
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(mockRedis.quit).toHaveBeenCalledTimes(1);
    });
  });
});
