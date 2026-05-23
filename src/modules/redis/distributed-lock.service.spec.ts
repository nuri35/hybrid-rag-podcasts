import { DistributedLockService } from './distributed-lock.service';
import type { RedisService } from './redis.service';

interface MockRedisService {
  setNX: jest.Mock<Promise<boolean>, [string, string, number]>;
  eval: jest.Mock<Promise<unknown>, [string, string[], string[]]>;
  exists: jest.Mock<Promise<boolean>, [string]>;
}

function makeMockRedisService(): MockRedisService {
  return {
    setNX: jest.fn<Promise<boolean>, [string, string, number]>(),
    eval: jest.fn<Promise<unknown>, [string, string[], string[]]>(),
    exists: jest.fn<Promise<boolean>, [string]>(),
  };
}

function build(): { service: DistributedLockService; redis: MockRedisService } {
  const redis = makeMockRedisService();
  const service = new DistributedLockService(redis as unknown as RedisService);
  return { service, redis };
}

describe('DistributedLockService', () => {
  describe('acquire', () => {
    it('returns acquired:true with generated ownerId when setNX wrote the key', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValueOnce(true);

      const result = await service.acquire('ingestion:in_progress', { ttlSeconds: 7200 });

      expect(result.acquired).toBe(true);
      expect(result.ownerId).not.toBeNull();
      expect(result.key).toBe('ingestion:in_progress');
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(redis.setNX).toHaveBeenCalledWith('ingestion:in_progress', result.ownerId, 7200);
    });

    it('forwards the caller-supplied TTL verbatim to setNX', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValueOnce(true);

      await service.acquire('k', { ttlSeconds: 60 });

      expect(redis.setNX).toHaveBeenCalledWith('k', expect.any(String), 60);
    });

    it('returns acquired:false with ownerId:null when key already exists', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValueOnce(false);

      const result = await service.acquire('k', { ttlSeconds: 7200 });

      expect(result.acquired).toBe(false);
      expect(result.ownerId).toBeNull();
      expect(result.key).toBe('k');
      expect(result.expiresAt).toBeNull();
    });

    it('generates a unique ownerId per call when none is supplied', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValue(true);

      const a = await service.acquire('k', { ttlSeconds: 60 });
      const b = await service.acquire('k', { ttlSeconds: 60 });

      expect(a.ownerId).not.toBeNull();
      expect(b.ownerId).not.toBeNull();
      expect(a.ownerId).not.toBe(b.ownerId);
      expect(a.ownerId).toMatch(new RegExp(`^${process.pid}-`));
    });

    it('uses the caller-supplied ownerId verbatim when provided', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValueOnce(true);

      const result = await service.acquire('k', { ttlSeconds: 60, ownerId: 'my-owner' });

      expect(result.ownerId).toBe('my-owner');
      expect(redis.setNX).toHaveBeenCalledWith('k', 'my-owner', 60);
    });

    it('sets expiresAt approximately ttlSeconds in the future', async () => {
      const { service, redis } = build();
      redis.setNX.mockResolvedValueOnce(true);
      const before = Date.now();

      const result = await service.acquire('k', { ttlSeconds: 60 });

      expect(result.expiresAt).not.toBeNull();
      const expiresMs = result.expiresAt!.getTime();
      // Should be ~60s in the future; tolerate any drift up to 5s for slow CI.
      expect(expiresMs - before).toBeGreaterThanOrEqual(60_000);
      expect(expiresMs - before).toBeLessThan(65_000);
    });
  });

  describe('release', () => {
    it('returns true when the Lua compare-and-delete returned 1', async () => {
      const { service, redis } = build();
      redis.eval.mockResolvedValueOnce(1);

      const result = await service.release('k', 'owner-1');

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("DEL", KEYS[1])'),
        ['k'],
        ['owner-1'],
      );
    });

    it('returns false when the Lua compare-and-delete returned 0 (wrong owner or expired)', async () => {
      const { service, redis } = build();
      redis.eval.mockResolvedValueOnce(0);

      const result = await service.release('k', 'owner-1');

      expect(result).toBe(false);
    });
  });

  describe('refresh', () => {
    it('returns true when the Lua compare-and-extend returned 1', async () => {
      const { service, redis } = build();
      redis.eval.mockResolvedValueOnce(1);

      const result = await service.refresh('k', 'owner-1', 7200);

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("EXPIRE", KEYS[1], ARGV[2])'),
        ['k'],
        ['owner-1', '7200'],
      );
    });

    it('returns false when the Lua compare-and-extend returned 0', async () => {
      const { service, redis } = build();
      redis.eval.mockResolvedValueOnce(0);

      const result = await service.refresh('k', 'owner-1', 7200);

      expect(result).toBe(false);
    });
  });

  describe('isLocked', () => {
    it('returns true when EXISTS reports the key is present', async () => {
      const { service, redis } = build();
      redis.exists.mockResolvedValueOnce(true);

      await expect(service.isLocked('k')).resolves.toBe(true);
      expect(redis.exists).toHaveBeenCalledWith('k');
    });

    it('returns false when EXISTS reports the key is absent', async () => {
      const { service, redis } = build();
      redis.exists.mockResolvedValueOnce(false);

      await expect(service.isLocked('k')).resolves.toBe(false);
    });
  });

  describe('error propagation', () => {
    it('lets RedisUnavailableException bubble from setNX (acquire path)', async () => {
      const { service, redis } = build();
      const error = new Error('redis down');
      redis.setNX.mockRejectedValueOnce(error);

      await expect(service.acquire('k', { ttlSeconds: 60 })).rejects.toBe(error);
    });

    it('lets RedisUnavailableException bubble from eval (release path)', async () => {
      const { service, redis } = build();
      const error = new Error('redis down');
      redis.eval.mockRejectedValueOnce(error);

      await expect(service.release('k', 'owner-1')).rejects.toBe(error);
    });
  });
});
