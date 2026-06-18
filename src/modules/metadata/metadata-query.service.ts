import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';
import type { SearchHit } from '@elastic/elasticsearch/lib/api/types';
import { ELASTICSEARCH_CLIENT } from '../elasticsearch/elasticsearch.constants';
import {
  DEFAULT_FILTER_LIMIT,
  DEFAULT_GROUP_BY_SIZE,
  KEYWORD_FIELDS,
  KEYWORD_FIELD_SET,
  MAX_FILTER_LIMIT,
  MAX_GROUP_BY_SIZE,
  METADATA_INDEX,
  METADATA_QUERY_TIMEOUT_MS,
  NUMERIC_FIELDS,
  NUMERIC_FIELD_SET,
} from './metadata.constants';
import { InvalidMetadataQueryException, MetadataQueryFailedException } from './exceptions';
import {
  MetadataAggregation,
  type EpisodeRef,
  type MetadataQueryRequest,
  type MetadataQueryResult,
} from './metadata.types';

/** `_source` shape of a `podcast_episodes` document. */
interface EpisodeSource {
  episode_id?: string;
  title?: string;
  guest_name?: string;
  duration_min?: number;
  total_chunks?: number;
}

/**
 * Phase 5.1 — exact, deterministic aggregation engine over the episode-grained
 * `podcast_episodes` index. It answers structured-fact questions the semantic
 * retriever cannot: counts, distinct counts, filters, numeric extremes/averages,
 * and groupings. This is the engine the future `query_metadata` tool (5.2) wraps;
 * it is built and trusted in isolation first.
 *
 * **Grain:** every aggregation runs against `podcast_episodes` (one doc per
 * episode), so `doc_count` IS an episode count — no chunk-count bias.
 *
 * **Fail-loud:** any ES error / malformed response throws
 * `MetadataQueryFailedException` (it never returns a guessed or degraded value).
 * Bad input throws `InvalidMetadataQueryException` BEFORE touching ES.
 *
 * **Trust boundary:** `aggregate()` revalidates every request at runtime (field
 * allow-lists, value/limit checks) because the 5.2 tool will feed untyped LLM
 * input through it. The compile-time discriminated union only protects internal
 * callers.
 */
@Injectable()
export class MetadataQueryService {
  private readonly logger = new Logger(MetadataQueryService.name);

  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly client: Client) {}

  async aggregate(request: MetadataQueryRequest): Promise<MetadataQueryResult> {
    this.validate(request);
    const startTime = Date.now();
    try {
      const result = await this.dispatch(request);
      this.logger.log(
        `metadata_query type=${request.type} ` +
          `field=${'field' in request ? request.field : (request.filter?.field ?? '-')} ` +
          `duration_ms=${Date.now() - startTime} summary=${this.summarize(result)}`,
      );
      return result;
    } catch (error) {
      // Re-throw validation errors untouched; wrap everything else fail-loud.
      if (error instanceof InvalidMetadataQueryException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `metadata_query_failed type=${request.type} ` +
          `duration_ms=${Date.now() - startTime} error=${message}`,
      );
      throw new MetadataQueryFailedException(message);
    }
  }

  // ----------------------------------------------------------------------------
  // Dispatch — one builder per aggregation type
  // ----------------------------------------------------------------------------

  private async dispatch(request: MetadataQueryRequest): Promise<MetadataQueryResult> {
    switch (request.type) {
      case MetadataAggregation.COUNT:
        return this.count(request.filter);
      case MetadataAggregation.COUNT_DISTINCT:
        return this.countDistinct(request.field);
      case MetadataAggregation.FILTER:
        return this.filter(request.field, request.value, request.limit);
      case MetadataAggregation.MIN:
      case MetadataAggregation.MAX:
        return this.extreme(request.type, request.field);
      case MetadataAggregation.AVG:
        return this.avg(request.field);
      case MetadataAggregation.GROUP_BY:
        return this.groupBy(request.field, request.size);
    }
  }

  private async count(filter?: { field: string; value: string }): Promise<MetadataQueryResult> {
    const query = filter
      ? { bool: { filter: [{ term: { [filter.field]: filter.value } }] } }
      : { match_all: {} };
    const response = await this.client.search(
      { index: METADATA_INDEX, size: 0, track_total_hits: true, query },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    return {
      type: MetadataAggregation.COUNT,
      value: this.totalOf(response.hits.total),
      ...(filter ? { filter } : {}),
    };
  }

  private async countDistinct(field: string): Promise<MetadataQueryResult> {
    const response = await this.client.search(
      { index: METADATA_INDEX, size: 0, aggs: { distinct: { cardinality: { field } } } },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    const agg = response.aggregations?.distinct as { value: number } | undefined;
    if (!agg) throw new Error('cardinality aggregation missing from response');
    return { type: MetadataAggregation.COUNT_DISTINCT, field, value: agg.value };
  }

  private async filter(field: string, value: string, limit?: number): Promise<MetadataQueryResult> {
    const size = this.clamp(limit, DEFAULT_FILTER_LIMIT, MAX_FILTER_LIMIT);
    const response = await this.client.search<EpisodeSource>(
      {
        index: METADATA_INDEX,
        size,
        track_total_hits: true,
        _source: ['episode_id', 'title', 'guest_name'],
        query: { bool: { filter: [{ term: { [field]: value } }] } },
      },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    return {
      type: MetadataAggregation.FILTER,
      field,
      value,
      count: this.totalOf(response.hits.total),
      episodes: response.hits.hits.map((hit) => this.toEpisodeRef(hit)),
    };
  }

  private async extreme(
    type: MetadataAggregation.MIN | MetadataAggregation.MAX,
    field: string,
  ): Promise<MetadataQueryResult> {
    // Sort + size:1 returns BOTH the extreme value and the episode that holds it.
    const order = type === MetadataAggregation.MIN ? 'asc' : 'desc';
    const response = await this.client.search<EpisodeSource>(
      {
        index: METADATA_INDEX,
        size: 1,
        sort: [{ [field]: order }],
        _source: ['episode_id', 'title', 'guest_name', field],
      },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    const hit = response.hits.hits[0];
    if (!hit?._source) {
      return { type, field, value: null, episode: null };
    }
    const raw = hit._source[field as keyof EpisodeSource];
    return {
      type,
      field,
      value: typeof raw === 'number' ? raw : null,
      episode: this.toEpisodeRef(hit),
    };
  }

  private async avg(field: string): Promise<MetadataQueryResult> {
    const response = await this.client.search(
      { index: METADATA_INDEX, size: 0, aggs: { average: { avg: { field } } } },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    const agg = response.aggregations?.average as { value: number | null } | undefined;
    if (!agg) throw new Error('avg aggregation missing from response');
    return { type: MetadataAggregation.AVG, field, value: agg.value };
  }

  private async groupBy(field: string, size?: number): Promise<MetadataQueryResult> {
    const bucketSize = this.clamp(size, DEFAULT_GROUP_BY_SIZE, MAX_GROUP_BY_SIZE);
    const response = await this.client.search(
      { index: METADATA_INDEX, size: 0, aggs: { groups: { terms: { field, size: bucketSize } } } },
      { requestTimeout: METADATA_QUERY_TIMEOUT_MS },
    );
    const agg = response.aggregations?.groups as
      | { buckets: Array<{ key: string | number; doc_count: number }> }
      | undefined;
    if (!agg) throw new Error('terms aggregation missing from response');
    return {
      type: MetadataAggregation.GROUP_BY,
      field,
      // doc_count IS an episode count on the episode-grained index.
      buckets: agg.buckets.map((bucket) => ({ key: String(bucket.key), count: bucket.doc_count })),
    };
  }

  // ----------------------------------------------------------------------------
  // Validation (runtime trust boundary)
  // ----------------------------------------------------------------------------

  private validate(request: MetadataQueryRequest): void {
    if (!Object.values(MetadataAggregation).includes(request.type)) {
      throw new InvalidMetadataQueryException(
        `unknown aggregation type "${String(request.type)}". Allowed: ` +
          Object.values(MetadataAggregation).join(', '),
      );
    }
    switch (request.type) {
      case MetadataAggregation.COUNT:
        if (request.filter) {
          this.assertKeywordField(request.filter.field);
          this.assertValue(request.filter.value);
        }
        return;
      case MetadataAggregation.COUNT_DISTINCT:
      case MetadataAggregation.GROUP_BY:
        this.assertKeywordField(request.field);
        return;
      case MetadataAggregation.FILTER:
        this.assertKeywordField(request.field);
        this.assertValue(request.value);
        return;
      case MetadataAggregation.MIN:
      case MetadataAggregation.MAX:
      case MetadataAggregation.AVG:
        this.assertNumericField(request.field);
        return;
    }
  }

  private assertKeywordField(field: string): void {
    if (!KEYWORD_FIELD_SET.has(field)) {
      throw new InvalidMetadataQueryException(
        `field "${String(field)}" is not an aggregatable keyword field. ` +
          `Allowed: ${KEYWORD_FIELDS.join(', ')}`,
      );
    }
  }

  private assertNumericField(field: string): void {
    if (!NUMERIC_FIELD_SET.has(field)) {
      throw new InvalidMetadataQueryException(
        `field "${String(field)}" is not an aggregatable numeric field. ` +
          `Allowed: ${NUMERIC_FIELDS.join(', ')}`,
      );
    }
  }

  private assertValue(value: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidMetadataQueryException('filter value must be a non-empty string');
    }
  }

  // ----------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------

  /** Normalize ES `hits.total` (number | { value } | undefined) to a number. */
  private totalOf(total: number | { value: number } | undefined): number {
    if (typeof total === 'number') return total;
    return total?.value ?? 0;
  }

  private toEpisodeRef(hit: SearchHit<EpisodeSource>): EpisodeRef {
    const source = hit._source ?? {};
    return {
      episodeId: String(source.episode_id ?? hit._id ?? ''),
      title: source.title ?? '',
      guestName: source.guest_name ?? '',
    };
  }

  private clamp(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1) {
      throw new InvalidMetadataQueryException(
        `limit/size must be a positive integer (got ${value})`,
      );
    }
    return Math.min(value, max);
  }

  private summarize(result: MetadataQueryResult): string {
    switch (result.type) {
      case MetadataAggregation.COUNT:
      case MetadataAggregation.COUNT_DISTINCT:
      case MetadataAggregation.AVG:
        return `value=${result.value}`;
      case MetadataAggregation.FILTER:
        return `count=${result.count} returned=${result.episodes.length}`;
      case MetadataAggregation.MIN:
      case MetadataAggregation.MAX:
        return `value=${result.value}`;
      case MetadataAggregation.GROUP_BY:
        return `buckets=${result.buckets.length}`;
    }
  }
}
