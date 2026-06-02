import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../../redis/redis.service';
import { QaResponseCacheService } from './qa-response-cache.service';
import type { BuildKeyInput, CachedResponse } from './qa-response-cache.types';
import type { QaSource } from '../qa.types';
import type { Env } from '../../../common/config/env.schema';

interface MockRedisService {
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<void>, [string, string, number?]>;
  del: jest.Mock<Promise<number>, [string]>;
}

function makeRedis(): MockRedisService {
  return {
    get: jest.fn<Promise<string | null>, [string]>(),
    set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
  };
}

function makeConfig(ttlSeconds = 3600): ConfigService<Env, true> {
  return { get: jest.fn().mockReturnValue(ttlSeconds) } as unknown as ConfigService<Env, true>;
}

function makeService(redis: MockRedisService, ttlSeconds = 3600): QaResponseCacheService {
  return new QaResponseCacheService(redis as unknown as RedisService, makeConfig(ttlSeconds));
}

const BASE_INPUT: BuildKeyInput = {
  question: 'What is consciousness?',
  topK: 5,
  chunkIds: ['ep1_chunk_0', 'ep1_chunk_1'],
  model: 'gemini-2.5-flash-lite',
  temperature: 0,
  promptHash: 'abcd1234',
  ingestionTimestamp: '2026-06-01T00:00:00.000Z',
};

function makeSource(chunkId: string): QaSource {
  return { chunkId, score: 0.9, excerpt: 'excerpt', metadata: {} };
}

function makeCached(): CachedResponse {
  return {
    answer: 'An answer with [Source 1].',
    sources: [makeSource('ep1_chunk_0')],
    chunksCount: 1,
    cachedAt: '2026-06-02T00:00:00.000Z',
  };
}

describe('QaResponseCacheService', () => {
  let redis: MockRedisService;
  let service: QaResponseCacheService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    redis = makeRedis();
    service = makeService(redis);
  });

  // -----------------------------------------------------------------
  // buildKey — pure key construction
  // -----------------------------------------------------------------
  describe('buildKey', () => {
    it('produces a deterministic key for identical inputs', () => {
      expect(service.buildKey(BASE_INPUT)).toBe(service.buildKey(BASE_INPUT));
    });

    it('is case-insensitive in the question (lowercase normalization)', () => {
      const upper = service.buildKey({ ...BASE_INPUT, question: 'WHAT IS CONSCIOUSNESS?' });
      const lower = service.buildKey({ ...BASE_INPUT, question: 'what is consciousness?' });
      expect(upper).toBe(lower);
    });

    it('ignores surrounding whitespace in the question (trim)', () => {
      const padded = service.buildKey({ ...BASE_INPUT, question: '   What is consciousness?   ' });
      expect(padded).toBe(service.buildKey(BASE_INPUT));
    });

    it('treats different unicode normalization forms as equal (NFC)', () => {
      // "é" as single code point (NFC) vs "e" + combining accent (NFD)
      const nfc = service.buildKey({ ...BASE_INPUT, question: 'café' });
      const nfd = service.buildKey({ ...BASE_INPUT, question: 'café' });
      expect(nfc).toBe(nfd);
    });

    it('produces different keys for different topK values', () => {
      const a = service.buildKey({ ...BASE_INPUT, topK: 5 });
      const b = service.buildKey({ ...BASE_INPUT, topK: 10 });
      expect(a).not.toBe(b);
    });

    it('produces different keys when chunk IDs differ', () => {
      const a = service.buildKey({ ...BASE_INPUT, chunkIds: ['ep1_chunk_0'] });
      const b = service.buildKey({ ...BASE_INPUT, chunkIds: ['ep2_chunk_0'] });
      expect(a).not.toBe(b);
    });

    it('produces the same key regardless of chunk ID order (sorted)', () => {
      const a = service.buildKey({ ...BASE_INPUT, chunkIds: ['ep1_chunk_0', 'ep1_chunk_1'] });
      const b = service.buildKey({ ...BASE_INPUT, chunkIds: ['ep1_chunk_1', 'ep1_chunk_0'] });
      expect(a).toBe(b);
    });

    it('produces different keys when the model name differs', () => {
      const a = service.buildKey({ ...BASE_INPUT, model: 'gemini-2.5-flash-lite' });
      const b = service.buildKey({ ...BASE_INPUT, model: 'gemini-2.0-flash' });
      expect(a).not.toBe(b);
    });

    it('produces different keys when the ingestion timestamp differs', () => {
      const a = service.buildKey({ ...BASE_INPUT, ingestionTimestamp: 'ts-1' });
      const b = service.buildKey({ ...BASE_INPUT, ingestionTimestamp: 'ts-2' });
      expect(a).not.toBe(b);
    });

    it('prefixes the key with the qa:v1 namespace and includes the segments in order', () => {
      const key = service.buildKey(BASE_INPUT);
      expect(
        key.startsWith('qa:v1:gemini-2.5-flash-lite:0:abcd1234:5:2026-06-01T00:00:00.000Z:'),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // get — read path
  // -----------------------------------------------------------------
  describe('get', () => {
    it('returns null and logs qa_cache_miss when the key is absent', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      redis.get.mockResolvedValueOnce(null);

      const result = await service.get('qa:v1:key', 'corr-1');

      expect(result).toBeNull();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('qa_cache_miss'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('correlation_id=corr-1'));
    });

    it('returns the parsed CachedResponse and logs qa_cache_hit on a hit', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const cached = makeCached();
      redis.get.mockResolvedValueOnce(JSON.stringify(cached));

      const result = await service.get('qa:v1:key', 'corr-2');

      expect(result).toEqual(cached);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('qa_cache_hit'));
    });

    it('returns null and logs fail-open when Redis throws on read', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      redis.get.mockRejectedValueOnce(new Error('redis down'));

      const result = await service.get('qa:v1:key', 'corr-3');

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('qa_cache_failed action=fail_open'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stage=read'));
    });

    it('deletes a corrupt entry and returns null when JSON parse fails', async () => {
      redis.get.mockResolvedValueOnce('{not-valid-json');

      const result = await service.get('qa:v1:key', 'corr-4');

      expect(result).toBeNull();
      expect(redis.del).toHaveBeenCalledWith('qa:v1:key');
    });
  });

  // -----------------------------------------------------------------
  // set — write path
  // -----------------------------------------------------------------
  describe('set', () => {
    it('writes to Redis with the configured TTL and logs qa_cache_stored', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const cached = makeCached();

      await service.set('qa:v1:key', cached, 'corr-5');

      expect(redis.set).toHaveBeenCalledWith('qa:v1:key', JSON.stringify(cached), 3600);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('qa_cache_stored'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ttl_seconds=3600'));
    });

    it('honors a custom CACHE_TTL_SECONDS from config', async () => {
      const customService = makeService(redis, 1800);
      await customService.set('qa:v1:key', makeCached(), 'corr-6');
      expect(redis.set).toHaveBeenCalledWith('qa:v1:key', expect.any(String), 1800);
    });

    it('swallows Redis write errors and logs fail-open (never throws)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      redis.set.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.set('qa:v1:key', makeCached(), 'corr-7')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('qa_cache_failed action=fail_open'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stage=write'));
    });
  });

  // -----------------------------------------------------------------
  // getIngestionTimestamp — Sprint A marker read
  // -----------------------------------------------------------------
  describe('getIngestionTimestamp', () => {
    it('returns the timestamp field from a JSON marker', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', actualChunks: 100 }),
      );
      await expect(service.getIngestionTimestamp()).resolves.toBe('2026-06-01T12:00:00.000Z');
    });

    it('returns the raw value when the marker is not JSON', async () => {
      redis.get.mockResolvedValueOnce('2026-06-01T12:00:00.000Z');
      await expect(service.getIngestionTimestamp()).resolves.toBe('2026-06-01T12:00:00.000Z');
    });

    it("returns 'none' when the marker is absent", async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(service.getIngestionTimestamp()).resolves.toBe('none');
    });

    it("returns 'none' when Redis throws", async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      await expect(service.getIngestionTimestamp()).resolves.toBe('none');
    });
  });

  // -----------------------------------------------------------------
  // promptHash — computed once at construction
  // -----------------------------------------------------------------
  describe('promptHash', () => {
    it('exposes a stable 8-char hex hash of the prompt template', () => {
      expect(service.promptHash).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
