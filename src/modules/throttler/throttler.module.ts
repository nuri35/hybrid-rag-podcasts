import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { Env } from '../../common/config/env.schema';

/**
 * Wraps `@nestjs/throttler` with our Redis-backed storage and two named
 * throttlers (`default` for the question endpoint, `stream` for the stricter
 * SSE endpoint). Limits are env-driven (see `THROTTLE_*` in env.schema.ts).
 *
 * The storage is instantiated inside the `useFactory` from the injected
 * `RedisService` rather than DI-injected by token. `forRootAsync` builds its
 * own internal module whose `inject` array resolves only against the modules
 * listed in its local `imports` — the outer module's `providers` are not
 * visible there, so injecting `RedisThrottlerStorage` directly would fail to
 * resolve. `RedisService` IS exported by the imported `RedisModule`, so we
 * inject that and construct the (stateless) storage ourselves. The storage is
 * also registered as a provider/export for direct use and testability.
 *
 * The global guard (`ProxyAwareThrottlerGuard` via `APP_GUARD`) is wired in
 * Step 2 — this module only configures storage + throttler definitions.
 */
@Module({
  imports: [
    RedisModule,
    NestThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService<Env, true>, redisService: RedisService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('THROTTLE_WINDOW_MS', { infer: true }),
            limit: config.get('THROTTLE_LIMIT_PER_MINUTE', { infer: true }),
          },
          {
            name: 'stream',
            ttl: config.get('THROTTLE_STREAM_WINDOW_MS', { infer: true }),
            limit: config.get('THROTTLE_STREAM_LIMIT_PER_MINUTE', { infer: true }),
          },
        ],
        storage: new RedisThrottlerStorage(redisService),
      }),
    }),
  ],
  providers: [RedisThrottlerStorage],
  exports: [NestThrottlerModule, RedisThrottlerStorage],
})
export class ThrottlerModule {}
