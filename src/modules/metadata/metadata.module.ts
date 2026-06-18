import { Module } from '@nestjs/common';
import { ElasticsearchModule } from '../elasticsearch/elasticsearch.module';
import { MetadataQueryService } from './metadata-query.service';

/**
 * Metadata-aggregation module (Phase 5.1).
 *
 * Provides `MetadataQueryService` — the exact aggregation engine over the
 * episode-grained `podcast_episodes` index. Imports `ElasticsearchModule` to
 * SHARE the singleton ES client via the `ELASTICSEARCH_CLIENT` DI token (no new
 * client). Kept separate from `ElasticsearchModule` by SRP: keyword *search* and
 * structured *aggregation* are distinct responsibilities.
 *
 * Exported for the future `query_metadata` tool (Phase 5.2) to wrap.
 */
@Module({
  imports: [ElasticsearchModule],
  providers: [MetadataQueryService],
  exports: [MetadataQueryService],
})
export class MetadataModule {}
