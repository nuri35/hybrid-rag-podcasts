import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MetadataModule } from '../metadata/metadata.module';
import { retrieverProvider } from '../qa/retriever.provider';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { QueryMetadataToolService } from './query-metadata.tool';
import { SearchContentToolService } from './search-content.tool';
import { ToolRouterService } from './tool-router.service';

/**
 * LLM tool layer (Phase 5.2).
 *
 * - `SearchContentToolService` (5.2.1) — wraps Phase 4 hybrid retrieval.
 * - `QueryMetadataToolService` (5.2.2) — wraps `MetadataQueryService` aggregations.
 *
 * - `ToolRouterService` (5.3.2) — binds both tools to Gemini and runs the
 *   single-shot two-call routing flow.
 *
 * DI notes: `SearchContentToolService` injects the `RETRIEVER` token, re-declared
 * here via the existing `retrieverProvider` (importing `RetrievalModule` for its
 * deps). `QueryMetadataToolService` injects `MetadataQueryService` from
 * `MetadataModule`. `ToolRouterService` injects `LlmService` (`LlmModule`) plus
 * both tool services. We deliberately do NOT import `QaModule` — that would create
 * a cycle once 5.4 wires the routing layer back into the QA pipeline. The Phase 4
 * retrieval path is untouched.
 */
@Module({
  imports: [RetrievalModule, MetadataModule, LlmModule],
  providers: [
    retrieverProvider,
    SearchContentToolService,
    QueryMetadataToolService,
    ToolRouterService,
  ],
  exports: [SearchContentToolService, QueryMetadataToolService, ToolRouterService],
})
export class ToolsModule {}
