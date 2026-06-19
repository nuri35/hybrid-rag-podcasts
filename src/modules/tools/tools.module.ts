import { Module } from '@nestjs/common';
import { MetadataModule } from '../metadata/metadata.module';
import { retrieverProvider } from '../qa/retriever.provider';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { QueryMetadataToolService } from './query-metadata.tool';
import { SearchContentToolService } from './search-content.tool';

/**
 * LLM tool layer (Phase 5.2).
 *
 * - `SearchContentToolService` (5.2.1) — wraps Phase 4 hybrid retrieval.
 * - `QueryMetadataToolService` (5.2.2) — wraps `MetadataQueryService` aggregations.
 *
 * DI notes: `SearchContentToolService` injects the `RETRIEVER` token, re-declared
 * here via the existing `retrieverProvider` (importing `RetrievalModule` for its
 * deps). `QueryMetadataToolService` injects `MetadataQueryService` from
 * `MetadataModule`. We deliberately do NOT import `QaModule` — that would create a
 * cycle once 5.4 wires the routing layer back into the QA pipeline. The Phase 4
 * retrieval path is untouched.
 */
@Module({
  imports: [RetrievalModule, MetadataModule],
  providers: [retrieverProvider, SearchContentToolService, QueryMetadataToolService],
  exports: [SearchContentToolService, QueryMetadataToolService],
})
export class ToolsModule {}
