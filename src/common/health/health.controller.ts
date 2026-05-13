import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import type { HealthResponseDto } from './health-response.dto';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check(): HealthResponseDto {
    return this.healthService.check();
  }
}
