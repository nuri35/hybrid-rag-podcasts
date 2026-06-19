import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';
import { ElasticsearchModule } from './modules/elasticsearch/elasticsearch.module';
import { FusionModule } from './modules/fusion/fusion.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { LlmModule } from './modules/llm/llm.module';
import { MetadataModule } from './modules/metadata/metadata.module';
import { QaModule } from './modules/qa/qa.module';
import { RedisModule } from './modules/redis/redis.module';
import { RetrievalModule } from './modules/retrieval/retrieval.module';
import { ThrottlerModule } from './modules/throttler/throttler.module';
import { ToolsModule } from './modules/tools/tools.module';

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    RedisModule,
    ThrottlerModule,
    IngestionModule,
    RetrievalModule,
    ElasticsearchModule,
    FusionModule,
    LlmModule,
    MetadataModule,
    QaModule,
    ToolsModule,
  ],
})
export class AppModule {}
