import { Injectable } from '@nestjs/common';
import type { HealthResponseDto } from './health-response.dto';

@Injectable()
export class HealthService {
  check(): HealthResponseDto {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
