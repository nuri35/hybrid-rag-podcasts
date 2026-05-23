import { Injectable } from '@nestjs/common';
import { DistributedLockService } from '../../modules/redis/distributed-lock.service';
import { REDIS_KEYS } from '../../modules/redis/redis.constants';
import { RedisService } from '../../modules/redis/redis.service';
import type { HealthResponseDto } from './health-response.dto';

@Injectable()
export class HealthService {
  constructor(
    private readonly redisService: RedisService,
    private readonly lockService: DistributedLockService,
  ) {}

  /**
   * Liveness + ingestion-state probe. Redis-aware: surfaces the Sprint A
   * lock state so an external load balancer / orchestrator can route
   * around the API while a long ingestion holds the lock. Never throws —
   * a Redis-down state is reflected in the body as `redis: 'down'`,
   * `ingestion.active: false`; the HTTP status stays 200 OK so the
   * process itself is still considered alive.
   */
  async check(): Promise<HealthResponseDto> {
    const redisHealthy = await this.redisService.isHealthy();
    const lockActive = redisHealthy
      ? await this.lockService.isLocked(REDIS_KEYS.INGESTION_LOCK).catch(() => false)
      : false;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        redis: redisHealthy ? 'up' : 'down',
      },
      ingestion: {
        active: lockActive,
      },
    };
  }
}
