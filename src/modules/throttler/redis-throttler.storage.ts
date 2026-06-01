import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../redis/redis.service';

const KEY_PREFIX = 'throttle:';

/**
 * Redis-backed {@link ThrottlerStorage} for `@nestjs/throttler`.
 *
 * Algorithm — fixed-window counter + TTL (the "approximation of a sliding
 * window" agreed in the sprint design, ADR 0014). Each (throttler, tracker)
 * pair owns one Redis key holding a monotonic hit counter; the key carries a
 * TTL equal to the throttler window. The first hit in a window sets the TTL,
 * subsequent hits only INCR. When the counter exceeds the limit the request
 * is blocked for the remainder of the window. Memory footprint is one small
 * key per active client per window — constant, unlike a sorted-set sliding
 * window. Accuracy trade-off is ~1-2 % at window boundaries, accepted by
 * design.
 *
 * Units — `ThrottlerStorageRecord.timeToExpire` / `timeToBlockExpire` are in
 * SECONDS, matching the library's default in-memory `ThrottlerStorageService`
 * (its `getExpirationTime` divides by 1000). The guard copies
 * `timeToBlockExpire` straight into the HTTP `Retry-After` header, which is
 * defined in seconds — returning milliseconds here would inflate it 1000×.
 * This is a deliberate deviation from the sprint's inline pseudo-code, which
 * returned milliseconds.
 *
 * Fail-open — every Redis error is swallowed and a "not blocked" record is
 * returned so the request proceeds, with a WARN log. Rate limiting is a
 * defense layer, not a correctness primitive; an unreachable Redis must not
 * take the API down. Same philosophy as Sprint A's degrade-gracefully paths.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `${KEY_PREFIX}${throttlerName}:${key}`;
    const ttlSeconds = Math.ceil(ttl / 1000);

    try {
      const currentCount = await this.incrementWithTtl(redisKey, ttlSeconds);
      const timeToExpire = await this.getTtlRemainingSeconds(redisKey);
      const isBlocked = currentCount > limit;

      return {
        totalHits: currentCount,
        timeToExpire,
        isBlocked,
        // The window TTL IS the block duration in this fixed-window model;
        // `_blockDuration` from the throttler config is intentionally unused.
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (error) {
      this.logger.warn(
        `throttler_storage_failed key=${redisKey} action=fail_open error=${(error as Error).message}`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /**
   * Atomic INCR + first-hit EXPIRE via a Lua script. Guarding EXPIRE behind
   * `current == 1` keeps the window anchored to the FIRST request — a plain
   * `INCR` then `EXPIRE` on every call would slide the window forward on each
   * hit and a client could never be throttled.
   */
  private async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const script = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const result = await this.redisService.eval(script, [key], [String(ttlSeconds)]);
    return Number(result);
  }

  private async getTtlRemainingSeconds(key: string): Promise<number> {
    const pttlMs = await this.redisService.pttl(key);
    return pttlMs > 0 ? Math.ceil(pttlMs / 1000) : 0;
  }
}
