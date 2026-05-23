import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { ChromaRepository } from '../../vector-store/chroma.repository';
import { DistributedLockService } from '../../redis/distributed-lock.service';
import { RedisService } from '../../redis/redis.service';
import { REDIS_KEYS } from '../../redis/redis.constants';
import { IngestionAlreadyRunningException, IngestionIncompleteException } from '../exceptions';
import type { IngestionMarker } from '../types/ingestion-marker.types';
import type { Env } from '../../../common/config/env.schema';
import type { IngestionOptions, IngestionResult, PodcastMetadata } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { TextCleanerService } from './text-cleaner.service';

/**
 * Marker / lock schema version. Tracks `package.json` version manually —
 * if the on-disk shape of the integrity marker ever changes (new fields,
 * removed fields, semantics shift), bump this so the next boot's startup
 * check sees a marker it does not understand and operator action is
 * forced. Currently mirrors package.json's `0.1.0`.
 */
const INGESTION_MARKER_VERSION = '0.1.0';

@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);
  private readonly defaultBatchSize: number;
  private readonly defaultConcurrency: number;
  private readonly lockTtlSeconds: number;
  private readonly lockRefreshIntervalMs: number;

  constructor(
    private readonly csvLoader: CsvLoaderService,
    private readonly textCleaner: TextCleanerService,
    private readonly chunker: ChunkerService,
    private readonly embedder: EmbedderService,
    private readonly chromaRepository: ChromaRepository,
    private readonly lockService: DistributedLockService,
    private readonly redisService: RedisService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultBatchSize = config.get('CHROMA_WRITE_BATCH_SIZE', { infer: true });
    this.defaultConcurrency = config.get('CHROMA_WRITE_CONCURRENCY', { infer: true });
    this.lockTtlSeconds = config.get('INGESTION_LOCK_TTL_SECONDS', { infer: true });
    this.lockRefreshIntervalMs = config.get('INGESTION_LOCK_REFRESH_INTERVAL_MS', { infer: true });
  }

  /**
   * Entry point. Wraps `executeIngestion` with the Phase 1.7.5 Sprint A
   * distributed lock + post-write integrity marker for real runs.
   * Dry-runs bypass the lock entirely — they read + chunk only, write
   * nothing, so coordination is unnecessary.
   */
  async run(options: IngestionOptions): Promise<IngestionResult> {
    if (options.dryRun === true) {
      return this.executeIngestion(options);
    }

    const lockResult = await this.lockService.acquire(REDIS_KEYS.INGESTION_LOCK, {
      ttlSeconds: this.lockTtlSeconds,
    });

    if (!lockResult.acquired) {
      throw new IngestionAlreadyRunningException();
    }

    const ownerId = lockResult.ownerId;
    // `ownerId` is non-null when `acquired` is true — narrow once for the
    // rest of the method so the refresh/release calls don't carry `!`.
    if (ownerId === null) {
      throw new Error('lock acquired but ownerId is null — should be unreachable');
    }

    this.logger.log(`ingestion_started owner_id=${ownerId}`);

    const startTime = Date.now();
    const refreshTimer = setInterval(() => {
      void this.refreshIngestionLock(ownerId);
    }, this.lockRefreshIntervalMs);

    try {
      const result = await this.executeIngestion(options);

      const expectedChunks = result.chunksProduced;
      const actualChunks = result.collectionCount ?? -1;

      // Strict equality only valid after a reset — non-reset re-runs
      // legitimately keep prior collection contents alongside the new
      // ones. We still write the marker either way; the startup check
      // only compares marker.actualChunks vs current count.
      if (options.reset === true) {
        if (actualChunks !== expectedChunks) {
          throw new IngestionIncompleteException(expectedChunks, actualChunks);
        }
      } else {
        this.logger.warn(
          `ingestion_commit_strict_check_skipped reason=non_reset_run ` +
            `expected=${expectedChunks} actual=${actualChunks} ` +
            `(strict check only meaningful after --reset)`,
        );
      }

      const sourceFileHash = await this.computeSourceFileHash(options.csvPath);
      const marker: IngestionMarker = {
        timestamp: new Date().toISOString(),
        expectedChunks,
        actualChunks,
        sourceFileHash,
        durationMs: Date.now() - startTime,
        ingestionVersion: INGESTION_MARKER_VERSION,
      };
      await this.redisService.set(REDIS_KEYS.INGESTION_LAST_SUCCESSFUL_RUN, JSON.stringify(marker));

      this.logger.log(
        `ingestion_completed actual_chunks=${actualChunks} ` +
          `expected_chunks=${expectedChunks} duration_ms=${marker.durationMs} ` +
          `source_hash=${sourceFileHash.substring(0, 12)}...`,
      );

      return result;
    } finally {
      clearInterval(refreshTimer);
      await this.lockService.release(REDIS_KEYS.INGESTION_LOCK, ownerId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`ingestion_lock_release_error error=${message}`);
      });
    }
  }

  /**
   * The original pre-Sprint-A pipeline body, factored out so the
   * lock-bearing wrapper above can call it without duplicating the
   * dry-run short-circuit.
   */
  private async executeIngestion(options: IngestionOptions): Promise<IngestionResult> {
    const startedAt = Date.now();
    const isDryRun = options.dryRun === true;

    this.logger.log(
      `Starting ingestion (csv=${options.csvPath}, reset=${options.reset === true}, dryRun=${isDryRun})`,
    );

    if (!isDryRun && options.reset === true) {
      await this.chromaRepository.resetCollection();
    }

    const documents = await this.csvLoader.load(options.csvPath);

    let bytesBefore = 0;
    let bytesAfter = 0;
    const cleanedDocs: Document<PodcastMetadata>[] = documents.map((doc) => {
      const original = doc.pageContent;
      const cleaned = this.textCleaner.clean(original);
      bytesBefore += Buffer.byteLength(original, 'utf8');
      bytesAfter += Buffer.byteLength(cleaned, 'utf8');
      return new Document<PodcastMetadata>({
        pageContent: cleaned,
        metadata: doc.metadata,
      });
    });
    const savedBytes = bytesBefore - bytesAfter;
    const savedPct = bytesBefore > 0 ? ((savedBytes / bytesBefore) * 100).toFixed(1) : '0.0';
    this.logger.log(
      `Cleaned ${cleanedDocs.length} documents; bytes before=${bytesBefore}, after=${bytesAfter}, saved=${savedBytes} (${savedPct}%)`,
    );

    const chunks = await this.chunker.split(cleanedDocs);

    if (isDryRun) {
      const durationMs = Date.now() - startedAt;
      const result: IngestionResult = {
        rowsLoaded: documents.length,
        rowsSkipped: this.csvLoader.getLastStats()?.skipped ?? 0,
        bytesBeforeCleaning: bytesBefore,
        bytesAfterCleaning: bytesAfter,
        chunksProduced: chunks.length,
        durationMs,
        dryRun: true,
      };
      this.logger.log(
        `Dry-run complete: ${result.rowsLoaded} docs, ${result.chunksProduced} chunks in ${durationMs}ms`,
      );
      return result;
    }

    const vectors = await this.embedder.embedBatch(chunks);
    await this.chromaRepository.addDocuments(chunks, vectors);
    const collectionCount = await this.chromaRepository.count();

    const writeBatches = Math.ceil(chunks.length / this.defaultBatchSize);
    const durationMs = Date.now() - startedAt;
    const result: IngestionResult = {
      rowsLoaded: documents.length,
      rowsSkipped: this.csvLoader.getLastStats()?.skipped ?? 0,
      bytesBeforeCleaning: bytesBefore,
      bytesAfterCleaning: bytesAfter,
      chunksProduced: chunks.length,
      vectorsProduced: vectors.length,
      vectorsWritten: vectors.length,
      collectionCount,
      writeBatches,
      writeBatchSize: this.defaultBatchSize,
      writeConcurrency: this.defaultConcurrency,
      durationMs,
      dryRun: false,
    };
    this.logger.log(
      `Ingestion complete: ${result.vectorsWritten} vectors written in ${durationMs}ms; ` +
        `collection now holds ${collectionCount}`,
    );
    return result;
  }

  /**
   * Fire-and-forget lock refresh. Wrapped in try/catch so a transient
   * Redis blip doesn't surface as an unhandled rejection. A `false`
   * return from `refresh` means the lock was lost (TTL expired or
   * another owner took over) — we log loudly but do NOT abort the
   * in-flight ingestion: the worst case is the marker write at the end
   * collides with another worker's, which Redis SET handles atomically.
   */
  private async refreshIngestionLock(ownerId: string): Promise<void> {
    try {
      const refreshed = await this.lockService.refresh(
        REDIS_KEYS.INGESTION_LOCK,
        ownerId,
        this.lockTtlSeconds,
      );
      if (!refreshed) {
        this.logger.warn(
          `ingestion_lock_refresh_failed owner_id=${ownerId} reason=lock_lost_or_expired`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`ingestion_lock_refresh_error owner_id=${ownerId} error=${message}`);
    }
  }

  private async computeSourceFileHash(csvPath: string): Promise<string> {
    const contents = await readFile(csvPath);
    return createHash('sha256').update(contents).digest('hex');
  }
}
