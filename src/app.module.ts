import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';

@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
