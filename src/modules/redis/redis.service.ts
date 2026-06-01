import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisUnavailableException } from './exceptions/redis-unavailable.exception';
import type { Env } from '../../common/config/env.schema';

/**
 * Minimal Redis facade backed by ioredis. Built for Phase 1.7.5's
 * distributed-lock + integrity-marker work; designed to extend cleanly
 * when Sprint B layers caching on top.
 *
 * Connection policy:
 *   - `enableOfflineQueue: false` — commands fail fast when Redis is
 *     disconnected; we never silently queue requests that the application
 *     thinks succeeded.
 *   - `maxRetriesPerRequest: 1` — one in-flight retry; broader retry/
 *     backoff is the caller's concern (lock refresh, cache fill).
 *   - `lazyConnect: true` — defer the socket connect until
 *     `onModuleInit` calls `connect()` explicitly. The combination of
 *     `lazyConnect: false` + `enableOfflineQueue: false` raced the
 *     handshake: `ping()` fired before the socket reached `ready`,
 *     and the disabled offline queue rejected it with
 *     `redis_initial_ping_failed`. Explicit connect awaits the
 *     handshake first, then `ping()` is guaranteed to find a writable
 *     stream.
 *
 * Error policy: all wrapped methods translate ioredis errors into
 * `RedisUnavailableException`. The exception carries an `operation` label
 * so the caller's log line names the failing step. `isHealthy()` is the
 * only method that NEVER throws — it powers the health endpoint and
 * fail-open paths.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(configService: ConfigService<Env, true>) {
    const password = configService.get('REDIS_PASSWORD', { infer: true });
    this.client = new Redis({
      host: configService.get('REDIS_HOST', { infer: true }),
      port: configService.get('REDIS_PORT', { infer: true }),
      password: password.length > 0 ? password : undefined,
      db: configService.get('REDIS_DB', { infer: true }),
      connectTimeout: configService.get('REDIS_CONNECTION_TIMEOUT_MS', { infer: true }),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    this.client.on('error', (err: Error) => {
      this.logger.warn(`redis_connection_error message=${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      // Explicit connect+ping in sequence — see class comment on
      // `lazyConnect: true`. `connect()` resolves when the socket reaches
      // `ready`; subsequent `ping()` is guaranteed to find a writable
      // stream and won't be rejected by `enableOfflineQueue: false`.
      await this.client.connect();
      await this.client.ping();
      this.logger.log('redis_connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `redis_initial_ping_failed error=${message} action=fail_open ` +
          `(service stays up; query path / integrity check degrade gracefully)`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async ping(): Promise<string> {
    try {
      return await this.client.ping();
    } catch (error) {
      throw new RedisUnavailableException('ping', error);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      throw new RedisUnavailableException(`get ${key}`, error);
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds !== undefined) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      throw new RedisUnavailableException(`set ${key}`, error);
    }
  }

  /**
   * Atomic set-if-not-exists with TTL. Returns true if the key was set
   * (caller now holds the slot/lock); false if it already existed.
   */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      throw new RedisUnavailableException(`setNX ${key}`, error);
    }
  }

  async del(key: string): Promise<number> {
    try {
      return await this.client.del(key);
    } catch (error) {
      throw new RedisUnavailableException(`del ${key}`, error);
    }
  }

  /**
   * Execute a Lua script atomically. Used by DistributedLockService for
   * owner-checked release and TTL refresh (compare-and-delete / compare-
   * and-extend patterns that ordinary GET + DEL would race on).
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    try {
      return await this.client.eval(script, keys.length, ...keys, ...args);
    } catch (error) {
      throw new RedisUnavailableException('eval', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) === 1;
    } catch (error) {
      throw new RedisUnavailableException(`exists ${key}`, error);
    }
  }

  /**
   * Remaining time-to-live of a key in milliseconds. Mirrors ioredis/Redis
   * PTTL semantics: a positive number is the remaining TTL, `-1` means the
   * key exists but has no expiry, `-2` means the key does not exist. Used by
   * RedisThrottlerStorage to translate the rate-limit window's remaining time
   * into the HTTP `Retry-After` value.
   */
  async pttl(key: string): Promise<number> {
    try {
      return await this.client.pttl(key);
    } catch (error) {
      throw new RedisUnavailableException(`pttl ${key}`, error);
    }
  }
}
