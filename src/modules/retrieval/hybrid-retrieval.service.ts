import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElasticsearchService } from '../elasticsearch/elasticsearch.service';
import { FUSION_OUTPUT_TOP_K } from '../fusion/rrf-fusion.constants';
import { RrfFusionService } from '../fusion/rrf-fusion.service';
import { SOURCE_TOP_K } from './hybrid-retrieval.constants';
import { NeighborExpansionService } from './neighbor-expansion.service';
import type { IRetriever, RetrievalOptions, RetrievedChunk } from './retrieval.types';
import { VectorRetrieverService } from './vector-retriever.service';
import type { Env } from '../../common/config/env.schema';

/**
 * Phase 4.4 — hybrid retrieval orchestrator.
 *
 * A THIN orchestrator (decision 1): fire the vector and keyword searches in
 * parallel, fuse their ranked lists with RRF, return the top-K. No caching, no
 * prompt logic, no other responsibility. Implements `IRetriever` so it is a
 * drop-in swap for `VectorRetrieverService` behind the `RETRIEVER` token — the
 * QA chain's call site does not change.
 *
 * Resilience (decisions 2 & 3): `Promise.allSettled` is defense-in-depth ON TOP
 * of each service's internal catch. A rejected side is treated as an empty list
 * (+ warn). RRF over (vector, []) or ([], keyword) reduces cleanly to the
 * surviving side's order, rescored — so vector-down survives keyword-only,
 * keyword-down survives vector-only, both-down yields [] and the QA chain's
 * existing empty-retrieval fallback takes over.
 *
 * Note on degradation signal: `VectorRetrieverService.retrieve()` throws on
 * failure (and on query validation) → surfaces as a rejection here. But
 * `ElasticsearchService.search()` already catches internally and returns [] →
 * so a real ES outage typically shows as `es_hits=0 degraded=none`, and the
 * `degraded=es` branch only fires on the rare defense-in-depth rejection. The
 * `es_hits` count is the primary ES-health signal.
 */
@Injectable()
export class HybridRetrievalService implements IRetriever {
  private readonly logger = new Logger(HybridRetrievalService.name);
  private readonly expansionEnabled: boolean;

  constructor(
    private readonly vectorRetriever: VectorRetrieverService,
    private readonly elasticsearchService: ElasticsearchService,
    private readonly rrfFusion: RrfFusionService,
    private readonly neighborExpansion: NeighborExpansionService,
    config: ConfigService<Env, true>,
  ) {
    this.expansionEnabled = config.get('NEIGHBOR_EXPANSION_ENABLED', { infer: true });
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievedChunk[]> {
    const outputTopK = options.topK ?? FUSION_OUTPUT_TOP_K;
    const queryLen = typeof query === 'string' ? query.length : 0;

    // Both launched before either is awaited → true parallelism (max-latency,
    // not sum). `.finally` stamps each side's own elapsed without altering the
    // settlement Promise.allSettled observes.
    const start = Date.now();
    let vectorMs = 0;
    let esMs = 0;
    const vectorCall = this.vectorRetriever.retrieve(query, { topK: SOURCE_TOP_K }).finally(() => {
      vectorMs = Date.now() - start;
    });
    const esCall = this.elasticsearchService.search(query, SOURCE_TOP_K).finally(() => {
      esMs = Date.now() - start;
    });

    const [vectorResult, esResult] = await Promise.allSettled([vectorCall, esCall]);

    const vectorHits = vectorResult.status === 'fulfilled' ? vectorResult.value : [];
    const esHits = esResult.status === 'fulfilled' ? esResult.value : [];

    if (vectorResult.status === 'rejected') {
      this.logger.warn(
        `hybrid_vector_failed query_len=${queryLen} reason=${this.reasonOf(vectorResult.reason)}`,
      );
    }
    if (esResult.status === 'rejected') {
      this.logger.warn(
        `hybrid_es_failed query_len=${queryLen} reason=${this.reasonOf(esResult.reason)}`,
      );
    }

    const fusionStart = Date.now();
    const fused = this.rrfFusion.fuse(vectorHits, esHits, outputTopK);
    const fusionMs = Date.now() - fusionStart;

    // Phase 4 eval methodology: surface the RRF-fused top-K BEFORE expansion so
    // rank metrics are measured on the true ranked list. The internal vector
    // sub-call above used `{ topK: SOURCE_TOP_K }` only — it never received this
    // callback — so this fires exactly once, with the fused (pre-expansion) list.
    options.captureFusedTopK?.(fused);

    // Phase 4 enhancement — post-fusion neighbor-chunk expansion. Pulls each
    // fused chunk's ±1 neighbors and glues them adjacent so a sentence split
    // across a chunk boundary (q017: 306→307) is reassembled for the LLM.
    // Toggle off → fused list passes through byte-identical (A/B eval seam).
    const fusedIds = new Set(fused.map((c) => c.id));
    let output = fused;
    if (this.expansionEnabled) {
      output = await this.neighborExpansion.expand(fused);
    }
    const neighborsAdded = output.reduce((n, c) => (fusedIds.has(c.id) ? n : n + 1), 0);

    const { unionSize, overlap } = this.overlapStats(vectorHits, esHits);
    const degraded = this.degradedLabel(
      vectorResult.status === 'rejected',
      esResult.status === 'rejected',
    );

    this.logger.log(
      `hybrid_retrieval vector_hits=${vectorHits.length} es_hits=${esHits.length} ` +
        `fused_unique=${unionSize} overlap=${overlap} ` +
        `vector_ms=${vectorMs} es_ms=${esMs} fusion_ms=${fusionMs} degraded=${degraded} ` +
        `expanded=${this.expansionEnabled} chunks_before=${fused.length} ` +
        `chunks_after=${output.length} neighbors_added=${neighborsAdded}`,
    );

    return output;
  }

  /** union size + intersection size of the two lists' chunk ids (health signal). */
  private overlapStats(
    vectorHits: RetrievedChunk[],
    esHits: RetrievedChunk[],
  ): { unionSize: number; overlap: number } {
    const vectorIds = new Set(vectorHits.map((c) => c.id));
    const esIds = new Set(esHits.map((c) => c.id));
    let overlap = 0;
    for (const id of esIds) {
      if (vectorIds.has(id)) overlap += 1;
    }
    return { unionSize: vectorIds.size + esIds.size - overlap, overlap };
  }

  private degradedLabel(
    vectorFailed: boolean,
    esFailed: boolean,
  ): 'none' | 'vector' | 'es' | 'both' {
    if (vectorFailed && esFailed) return 'both';
    if (vectorFailed) return 'vector';
    if (esFailed) return 'es';
    return 'none';
  }

  private reasonOf(reason: unknown): string {
    if (reason instanceof Error) return `${reason.constructor.name}:${reason.message}`;
    return String(reason);
  }
}
