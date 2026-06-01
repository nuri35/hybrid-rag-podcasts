import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import type { HealthResponseDto } from './health-response.dto';

// Bypass rate limiting entirely — monitoring tools / load balancers poll
// this endpoint frequently and must never be throttled (a 429 here would
// trip false liveness/readiness alarms). Both named throttlers must be
// listed explicitly: bare `@SkipThrottle()` defaults to `{ default: true }`
// and would leave the custom `stream` throttler still binding this route.
@SkipThrottle({ default: true, stream: true })
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthResponseDto> {
    return this.healthService.check();
  }
}
