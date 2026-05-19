import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { RetrievalModule } from './modules/retrieval/retrieval.module';

@Module({
  imports: [ConfigModule, HealthModule, IngestionModule, RetrievalModule],
})
export class AppModule {}
