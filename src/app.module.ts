import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { LlmModule } from './modules/llm/llm.module';
import { QaModule } from './modules/qa/qa.module';
import { RedisModule } from './modules/redis/redis.module';
import { RetrievalModule } from './modules/retrieval/retrieval.module';

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    RedisModule,
    IngestionModule,
    RetrievalModule,
    LlmModule,
    QaModule,
  ],
})
export class AppModule {}
