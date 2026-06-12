import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';
import type {
  SearchHit,
  SearchResponse,
} from '@elastic/elasticsearch/lib/api/types';
import { METADATA_KEYS } from '../retrieval/retrieval.constants';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import {
  DEFAULT_TOP_K,
  ELASTICSEARCH_CLIENT,
  HEALTH_TIMEOUT_MS,
  INDEX_NAME,
  SEARCH_TIMEOUT_MS,
} from './elasticsearch.constants';

/**
 * The `_source` an indexed `podcast_chunks` document carries (written by
 * `scripts/elasticsearch/ingest-chunks.py`). `text` is the analyzed body; the
 * rest are the same metadata keys Chroma stores, so `_source` minus `text`
 * reproduces the vector side's `metadata` object key-for-key.
 */
interface PodcastChunkSource {
  text?: string;
  chunk_id?: string;
  chunk_index?: number;
  [key: string]: unknown;
}

/**
 * Phase 4.2 — keyword (BM25) retrieval over Elasticsearch.
 *
 * A plain `match` query on the english-analyzed `text` field (no bool/boost/
 * multi_match — analyzer + raw question proven sufficient in 4.1.5 smoke tests;
 * no tuning until 4.5). Returns `RetrievedChunk[]`, the SAME type the vector
 * retriever returns, so RRF fusion (4.3) consumes both without adapters.
 *
 * **Graceful degradation is the core contract:** every failure mode at query
 * time (cluster down, timeout, missing index, malformed response) is caught,
 * logged at WARN, and converted to an EMPTY array. The hybrid pipeline then
 * degrades to vector-only — a request must NEVER fail because the keyword side
 * is unavailable. `search()` therefore never throws.
 *
 * Dormant after this sub-phase: nothing calls it until pipeline wiring in 4.4.
 */
@Injectable()
export class ElasticsearchService {
  private readonly logger = new Logger(ElasticsearchService.name);

  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly client: Client) {}

  /**
   * BM25 keyword search. Returns up to `topK` hits as `RetrievedChunk[]`.
   * Empty/whitespace query short-circuits to `[]` with no ES round-trip.
   * Any error degrades to `[]` (logged) — never throws.
   */
  async search(query: string, topK: number = DEFAULT_TOP_K): Promise<RetrievedChunk[]> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return [];
    }

    const startTime = Date.now();
    try {
      const response = (await this.client.search(
        {
          index: INDEX_NAME,
          size: topK,
          query: { match: { text: query } },
        },
        { requestTimeout: SEARCH_TIMEOUT_MS },
      )) as SearchResponse<PodcastChunkSource>;

      const chunks = this.mapHits(response.hits.hits);
      // Log query LENGTH, not the text — keeps logs clean and PII-free.
      this.logger.log(
        `es_search_complete query_len=${query.length} top_k=${topK} ` +
          `returned=${chunks.length} duration_ms=${Date.now() - startTime}`,
      );
      return chunks;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;
      this.logger.warn(
        `es_search_failed query_len=${query.length} top_k=${topK} ` +
          `duration_ms=${Date.now() - startTime} error_class=${errorClass} ` +
          `error_message=${message} action=degrade_to_empty`,
      );
      return [];
    }
  }

  /**
   * Cluster-health probe for the aggregate `/health` endpoint. `green` or
   * `yellow` → healthy (yellow is normal for a single-node dev cluster with
   * 0 replicas). `red`, unreachable, or timeout → false. Never throws.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.client.cluster.health(
        {},
        { requestTimeout: HEALTH_TIMEOUT_MS },
      );
      return health.status === 'green' || health.status === 'yellow';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`es_health_check_failed error_message=${message}`);
      return false;
    }
  }

  /**
   * Map ES hits → `RetrievedChunk[]`, symmetric with the vector retriever:
   *   - `id`         ← `_source.chunk_id` (falls back to `_id`; they are equal)
   *   - `document`   ← `_source.text`
   *   - `score`      ← `_score` (raw BM25 — see EsRetrievalHit doc)
   *   - `metadata`   ← `_source` minus `text` (same key set as Chroma metadata)
   *   - `chunkIndex` ← `_source.chunk_index` (numeric in ES; warn + array-index
   *                    fallback mirrors the vector side's drift guard)
   */
  private mapHits(hits: Array<SearchHit<PodcastChunkSource>>): RetrievedChunk[] {
    return hits.map((hit, idx) => {
      const source = hit._source ?? {};
      const { text, ...metadata } = source;
      const id = String(source.chunk_id ?? hit._id);

      const rawIndex = metadata[METADATA_KEYS.CHUNK_INDEX];
      let chunkIndex: number;
      if (typeof rawIndex === 'number') {
        chunkIndex = rawIndex;
      } else {
        this.logger.warn(
          `es_metadata_chunk_index_fallback id=${id} ` +
            `expected_key=${METADATA_KEYS.CHUNK_INDEX} ` +
            `received_type=${typeof rawIndex} using_array_idx=${idx}`,
        );
        chunkIndex = idx;
      }

      return {
        id,
        document: typeof text === 'string' ? text : '',
        score: typeof hit._score === 'number' ? hit._score : 0,
        metadata,
        chunkIndex,
      };
    });
  }
}
