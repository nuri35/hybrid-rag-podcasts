import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LockOptions, LockResult } from './distributed-lock.types';
import { RedisService } from './redis.service';

/**
 * Distributed lock primitive on top of RedisService. The classic
 * "process A's lock gets released by process B by accident" failure mode
 * is prevented by storing an owner-id at the key and only releasing/
 * refreshing when the caller proves ownership via a Lua compare-and-act
 * script — atomic on the Redis side.
 *
 * Reusable beyond Phase 1.7.5 Sprint A's ingestion lock: future caching
 * invalidation, cron-job coordination, single-leader work all share this
 * primitive.
 */

/**
 * Atomic compare-and-delete: returns 1 only when the stored value equals
 * the caller's owner-id (i.e. the caller still owns the lock).
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Atomic compare-and-extend: returns 1 only when the stored value equals
 * the caller's owner-id, in which case the TTL is reset.
 */
const REFRESH_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(private readonly redisService: RedisService) {}

  async acquire(key: string, options: LockOptions): Promise<LockResult> {
    const ownerId = options.ownerId ?? `${process.pid}-${randomUUID()}`;
    const acquired = await this.redisService.setNX(key, ownerId, options.ttlSeconds);

    if (acquired) {
      this.logger.log(
        `lock_acquired key=${key} owner_id=${ownerId} ttl_seconds=${options.ttlSeconds}`,
      );
      return {
        acquired: true,
        ownerId,
        key,
        expiresAt: new Date(Date.now() + options.ttlSeconds * 1000),
      };
    }

    this.logger.warn(`lock_acquire_failed key=${key} reason=already_held`);
    return { acquired: false, ownerId: null, key, expiresAt: null };
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    const result = await this.redisService.eval(RELEASE_LOCK_SCRIPT, [key], [ownerId]);
    const released = result === 1;

    if (released) {
      this.logger.log(`lock_released key=${key} owner_id=${ownerId}`);
    } else {
      this.logger.warn(
        `lock_release_failed key=${key} owner_id=${ownerId} reason=not_owner_or_expired`,
      );
    }

    return released;
  }

  async refresh(key: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redisService.eval(
      REFRESH_LOCK_SCRIPT,
      [key],
      [ownerId, String(ttlSeconds)],
    );
    return result === 1;
  }

  async isLocked(key: string): Promise<boolean> {
    return this.redisService.exists(key);
  }
}
