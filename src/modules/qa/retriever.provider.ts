import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.schema';
import { HybridRetrievalService } from '../retrieval/hybrid-retrieval.service';
import { RETRIEVER } from '../retrieval/retrieval.constants';
import type { IRetriever } from '../retrieval/retrieval.types';
import { VectorRetrieverService } from '../retrieval/vector-retriever.service';

/**
 * The ONE toggle seam (Phase 4.4, decision 5). Picks the active retriever the
 * QA chain consumes based on `HYBRID_RETRIEVAL_ENABLED`:
 *   - true (default) → `HybridRetrievalService` (vector + ES + RRF)
 *   - false          → `VectorRetrieverService` (legacy Phase 2 path)
 *
 * Exported as a named function so the toggle logic is unit-testable without a
 * full Nest context.
 */
export function selectRetriever(
  config: ConfigService<Env, true>,
  vector: VectorRetrieverService,
  hybrid: HybridRetrievalService,
): IRetriever {
  return config.get('HYBRID_RETRIEVAL_ENABLED', { infer: true }) ? hybrid : vector;
}

/**
 * Factory provider binding the `RETRIEVER` token. `QaChainService` injects the
 * token (typed `IRetriever`), so flipping the flag swaps the whole retrieval
 * path with no change at the call site and no scattered conditionals.
 */
export const retrieverProvider: Provider = {
  provide: RETRIEVER,
  inject: [ConfigService, VectorRetrieverService, HybridRetrievalService],
  useFactory: selectRetriever,
};
