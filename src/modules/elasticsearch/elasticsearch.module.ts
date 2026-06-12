import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import type { Env } from '../../common/config/env.schema';
import { ELASTICSEARCH_CLIENT, SEARCH_TIMEOUT_MS } from './elasticsearch.constants';
import { ElasticsearchService } from './elasticsearch.service';

/**
 * Elasticsearch keyword-retrieval module (Phase 4.2).
 *
 * Provides a SINGLETON `@elastic/elasticsearch` Client built once from
 * `ELASTICSEARCH_URL` (internal connection pooling — never per-request) behind
 * the `ELASTICSEARCH_CLIENT` token, plus `ElasticsearchService` over it.
 *
 * `maxRetries: 0` — the service owns the failure policy (graceful degradation
 * to an empty list); hidden client-level retries would only inflate latency
 * before that degradation kicks in. ConfigModule is global, so it need not be
 * imported here.
 *
 * Exported for: HealthModule (health probe) now, and the future
 * HybridRetrievalService (4.4) that fuses this with the vector side.
 */
@Module({
  providers: [
    {
      provide: ELASTICSEARCH_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Client => {
        const node = config.get('ELASTICSEARCH_URL', { infer: true });
        return new Client({ node, requestTimeout: SEARCH_TIMEOUT_MS, maxRetries: 0 });
      },
    },
    ElasticsearchService,
  ],
  exports: [ElasticsearchService],
})
export class ElasticsearchModule {}
