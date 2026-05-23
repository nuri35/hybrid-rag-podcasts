import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ChromaRepository } from '../../vector-store/chroma.repository';
import { DistributedLockService } from '../../redis/distributed-lock.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.constants';
import { IngestionAlreadyRunningException, IngestionIncompleteException } from '../exceptions';
import type { IngestionMarker } from '../types/ingestion-marker.types';
import type { IngestionOptions, IngestionResult } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { IngestionPipelineService } from './ingestion-pipeline.service';
import { TextCleanerService } from './text-cleaner.service';

// Globally mock fs/promises so the marker's source-file-hash computation
// does not need a real CSV on disk. computeSourceFileHash hashes the
// returned buffer — tests only need the call to succeed.
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('test csv content')),
}));

interface ConfigOverrides {
  INGESTION_LOCK_TTL_SECONDS?: number;
  INGESTION_LOCK_REFRESH_INTERVAL_MS?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    CHROMA_WRITE_BATCH_SIZE: 500,
    CHROMA_WRITE_CONCURRENCY: 3,
    INGESTION_LOCK_TTL_SECONDS: 7200,
    INGESTION_LOCK_REFRESH_INTERVAL_MS: 300_000,
    ...overrides,
  };
  return { get: (key: string): unknown => values[key] } as unknown as ConfigService;
}

interface MockLockService {
  acquire: jest.Mock<
    Promise<{ acquired: boolean; ownerId: string | null; key: string; expiresAt: Date | null }>,
    [string, { ttlSeconds: number; ownerId?: string }]
  >;
  refresh: jest.Mock<Promise<boolean>, [string, string, number]>;
  release: jest.Mock<Promise<boolean>, [string, string]>;
}

function makeMockLockService(): MockLockService {
  const mock = {
    acquire: jest.fn<
      Promise<{ acquired: boolean; ownerId: string | null; key: string; expiresAt: Date | null }>,
      [string, { ttlSeconds: number; ownerId?: string }]
    >(),
    refresh: jest.fn<Promise<boolean>, [string, string, number]>(),
    release: jest.fn<Promise<boolean>, [string, string]>(),
  };
  mock.acquire.mockResolvedValue({
    acquired: true,
    ownerId: 'test-owner-1',
    key: REDIS_KEYS.INGESTION_LOCK,
    expiresAt: new Date(Date.now() + 7200 * 1000),
  });
  mock.refresh.mockResolvedValue(true);
  mock.release.mockResolvedValue(true);
  return mock;
}

interface MockRedisService {
  set: jest.Mock<Promise<void>, [string, string, number?]>;
}

function makeMockRedisService(): MockRedisService {
  const mock = { set: jest.fn<Promise<void>, [string, string, number?]>() };
  mock.set.mockResolvedValue(undefined);
  return mock;
}

/**
 * Service under test with a mock `executeIngestion` that bypasses the
 * full CSV → chunk → embed → write pipeline. Tests focus on the Sprint A
 * lock + marker lifecycle around the call.
 */
async function buildService(
  configOverrides: ConfigOverrides = {},
  overrides: { lockService?: MockLockService; redisService?: MockRedisService } = {},
  executeResult: Partial<IngestionResult> = {},
): Promise<{
  service: IngestionPipelineService;
  lockService: MockLockService;
  redisService: MockRedisService;
  executeSpy: jest.SpyInstance;
}> {
  const lockService = overrides.lockService ?? makeMockLockService();
  const redisService = overrides.redisService ?? makeMockRedisService();
  const defaultExecuteResult: IngestionResult = {
    rowsLoaded: 10,
    rowsSkipped: 0,
    bytesBeforeCleaning: 1000,
    bytesAfterCleaning: 900,
    chunksProduced: 100,
    vectorsProduced: 100,
    vectorsWritten: 100,
    collectionCount: 100,
    writeBatches: 1,
    writeBatchSize: 500,
    writeConcurrency: 3,
    durationMs: 100,
    dryRun: false,
    ...executeResult,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      IngestionPipelineService,
      { provide: CsvLoaderService, useValue: { load: jest.fn(), getLastStats: jest.fn() } },
      { provide: TextCleanerService, useValue: { clean: jest.fn() } },
      { provide: ChunkerService, useValue: { split: jest.fn() } },
      { provide: EmbedderService, useValue: { embedBatch: jest.fn() } },
      {
        provide: ChromaRepository,
        useValue: { resetCollection: jest.fn(), addDocuments: jest.fn(), count: jest.fn() },
      },
      { provide: DistributedLockService, useValue: lockService },
      { provide: RedisService, useValue: redisService },
      { provide: ConfigService, useValue: makeConfig(configOverrides) },
    ],
  }).compile();

  const service = moduleRef.get(IngestionPipelineService);
  // White-box: replace `executeIngestion` so we test only the wrapper.
  const executeSpy = jest
    .spyOn(
      service as unknown as { executeIngestion: () => Promise<IngestionResult> },
      'executeIngestion',
    )
    .mockResolvedValue(defaultExecuteResult);

  return { service, lockService, redisService, executeSpy };
}

function makeOptions(overrides: Partial<IngestionOptions> = {}): IngestionOptions {
  return {
    csvPath: '/tmp/test.csv',
    reset: true,
    dryRun: false,
    ...overrides,
  };
}

describe('IngestionPipelineService — Sprint A lock + marker lifecycle', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --------------------------------------------------------------
  // Acquire branch
  // --------------------------------------------------------------
  describe('acquire', () => {
    it('throws IngestionAlreadyRunningException when lock acquire returns acquired:false', async () => {
      const lockService = makeMockLockService();
      lockService.acquire.mockResolvedValueOnce({
        acquired: false,
        ownerId: null,
        key: REDIS_KEYS.INGESTION_LOCK,
        expiresAt: null,
      });

      const { service, executeSpy } = await buildService({}, { lockService });

      await expect(service.run(makeOptions())).rejects.toBeInstanceOf(
        IngestionAlreadyRunningException,
      );
      // Pipeline must not have run, marker must not have been touched.
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('forwards INGESTION_LOCK_TTL_SECONDS to lockService.acquire', async () => {
      const { service, lockService } = await buildService({
        INGESTION_LOCK_TTL_SECONDS: 60,
      });

      await service.run(makeOptions());

      expect(lockService.acquire).toHaveBeenCalledWith(REDIS_KEYS.INGESTION_LOCK, {
        ttlSeconds: 60,
      });
    });

    it('skips the lock entirely on dry-run', async () => {
      const { service, lockService, executeSpy, redisService } = await buildService();

      await service.run(makeOptions({ dryRun: true }));

      expect(lockService.acquire).not.toHaveBeenCalled();
      expect(lockService.release).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------
  // Refresh + finally cleanup
  // --------------------------------------------------------------
  describe('refresh timer + finally cleanup', () => {
    it('registers a setInterval at INGESTION_LOCK_REFRESH_INTERVAL_MS', async () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const { service } = await buildService({
        INGESTION_LOCK_REFRESH_INTERVAL_MS: 1000,
      });

      await service.run(makeOptions());

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      setIntervalSpy.mockRestore();
    });

    it('calls lockService.refresh when the refresh interval elapses during ingestion', async () => {
      jest.useFakeTimers();

      const lockService = makeMockLockService();
      // Hold executeIngestion open long enough for one timer tick.
      let resolveExecute: (value: IngestionResult) => void = () => undefined;
      const executePromise = new Promise<IngestionResult>((resolve) => {
        resolveExecute = resolve;
      });

      const { service } = await buildService(
        { INGESTION_LOCK_REFRESH_INTERVAL_MS: 1000 },
        { lockService },
      );
      jest
        .spyOn(
          service as unknown as { executeIngestion: () => Promise<IngestionResult> },
          'executeIngestion',
        )
        .mockReturnValueOnce(executePromise);

      const runPromise = service.run(makeOptions());
      // Advance past the refresh interval; fake timers fire the
      // setInterval callback synchronously, then microtasks flush.
      await jest.advanceTimersByTimeAsync(1500);

      expect(lockService.refresh).toHaveBeenCalledWith(
        REDIS_KEYS.INGESTION_LOCK,
        'test-owner-1',
        7200,
      );

      // Now let the pipeline finish so run() can complete.
      resolveExecute({
        rowsLoaded: 0,
        rowsSkipped: 0,
        bytesBeforeCleaning: 0,
        bytesAfterCleaning: 0,
        chunksProduced: 100,
        collectionCount: 100,
        durationMs: 0,
        dryRun: false,
      });
      await runPromise;
    });

    it('releases the lock in finally even when executeIngestion throws', async () => {
      const lockService = makeMockLockService();
      const { service } = await buildService({}, { lockService });
      jest
        .spyOn(
          service as unknown as { executeIngestion: () => Promise<IngestionResult> },
          'executeIngestion',
        )
        .mockRejectedValueOnce(new Error('boom'));

      await expect(service.run(makeOptions())).rejects.toThrow('boom');
      expect(lockService.release).toHaveBeenCalledWith(REDIS_KEYS.INGESTION_LOCK, 'test-owner-1');
    });

    it('clears the refresh timer in finally — no extra refresh after run resolves', async () => {
      jest.useFakeTimers();

      const lockService = makeMockLockService();
      const { service } = await buildService(
        { INGESTION_LOCK_REFRESH_INTERVAL_MS: 1000 },
        { lockService },
      );

      await service.run(makeOptions());
      const callsAtCompletion = lockService.refresh.mock.calls.length;

      // Advance 10 refresh intervals after run() has completed. If
      // clearInterval was missed, refresh would fire ~10 more times.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(lockService.refresh.mock.calls.length).toBe(callsAtCompletion);
    });
  });

  // --------------------------------------------------------------
  // Commit-point verification + marker writing
  // --------------------------------------------------------------
  describe('commit verification + marker write', () => {
    it('writes marker with the correct shape on a successful --reset run', async () => {
      const { service, redisService } = await buildService(
        {},
        {},
        { chunksProduced: 100, collectionCount: 100 },
      );

      await service.run(makeOptions({ reset: true }));

      expect(redisService.set).toHaveBeenCalledTimes(1);
      const [key, payload] = redisService.set.mock.calls[0];
      expect(key).toBe(REDIS_KEYS.INGESTION_LAST_SUCCESSFUL_RUN);
      const marker = JSON.parse(payload) as IngestionMarker;
      expect(marker).toMatchObject({
        expectedChunks: 100,
        actualChunks: 100,
        ingestionVersion: '0.1.0',
      });
      expect(typeof marker.timestamp).toBe('string');
      expect(marker.sourceFileHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      expect(typeof marker.durationMs).toBe('number');
    });

    it('throws IngestionIncompleteException when --reset run shows count mismatch', async () => {
      const { service, redisService } = await buildService(
        {},
        {},
        { chunksProduced: 100, collectionCount: 42 },
      );

      const caught = await service.run(makeOptions({ reset: true })).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(IngestionIncompleteException);
      expect((caught as IngestionIncompleteException).expected).toBe(100);
      expect((caught as IngestionIncompleteException).actual).toBe(42);
      // CRITICAL: marker must NOT have been written on verification failure.
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('still releases the lock when the integrity check fails (finally fires)', async () => {
      const { service, lockService } = await buildService(
        {},
        {},
        { chunksProduced: 100, collectionCount: 42 },
      );

      await service.run(makeOptions({ reset: true })).catch(() => undefined);
      expect(lockService.release).toHaveBeenCalledWith(REDIS_KEYS.INGESTION_LOCK, 'test-owner-1');
    });

    it('skips strict equality on a non-reset run but still writes the marker', async () => {
      // Non-reset re-runs legitimately keep prior collection contents, so
      // actualChunks > expectedChunks is normal. The marker still records
      // both values so the startup integrity check can use the canonical
      // count from the marker.
      const { service, redisService } = await buildService(
        {},
        {},
        { chunksProduced: 100, collectionCount: 153_000 },
      );

      await service.run(makeOptions({ reset: false }));

      expect(redisService.set).toHaveBeenCalledTimes(1);
      const payload = redisService.set.mock.calls[0][1];
      const marker = JSON.parse(payload) as IngestionMarker;
      expect(marker.expectedChunks).toBe(100);
      expect(marker.actualChunks).toBe(153_000);
    });

    it('does not write the marker when executeIngestion itself throws', async () => {
      const { service, redisService } = await buildService();
      jest
        .spyOn(
          service as unknown as { executeIngestion: () => Promise<IngestionResult> },
          'executeIngestion',
        )
        .mockRejectedValueOnce(new Error('chroma down mid-flight'));

      await service.run(makeOptions()).catch(() => undefined);
      expect(redisService.set).not.toHaveBeenCalled();
    });
  });
});
