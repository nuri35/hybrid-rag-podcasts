import { Module } from '@nestjs/common';
import { retrieverProvider } from '../qa/retriever.provider';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { SearchContentToolService } from './search-content.tool';

/**
 * LLM tool layer (Phase 5.2).
 *
 * 5.2.1 provides `SearchContentToolService` (wraps Phase 4 hybrid retrieval).
 *
 * DI note: the service injects the `RETRIEVER` token. We re-declare that binding
 * here via the existing `retrieverProvider` (which `selectRetriever`s
 * hybrid-vs-vector from `HYBRID_RETRIEVAL_ENABLED`), importing `RetrievalModule`
 * for its deps. We deliberately do NOT import `QaModule` — that would create a
 * cycle once 5.4 wires the routing layer back into the QA pipeline. The Phase 4
 * retrieval path is untouched; this binding is an additive, stateless duplicate.
 */
@Module({
  imports: [RetrievalModule],
  providers: [retrieverProvider, SearchContentToolService],
  exports: [SearchContentToolService],
})
export class ToolsModule {}
