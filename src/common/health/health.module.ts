import { Module } from '@nestjs/common';
import { ElasticsearchModule } from '../../modules/elasticsearch/elasticsearch.module';
import { RedisModule } from '../../modules/redis/redis.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [RedisModule, ElasticsearchModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
