import { Injectable, Logger } from '@nestjs/common';
import { MetadataQueryService } from '../metadata/metadata-query.service';
import { InvalidMetadataQueryException } from '../metadata/exceptions';
import {
  MetadataAggregation,
  type KeywordField,
  type MetadataQueryRequest,
  type MetadataQueryResult,
  type NumericField,
} from '../metadata/metadata.types';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import { queryMetadataInputSchema, type QueryMetadataInput } from './query-metadata.schema';
import type { QueryMetadataResult } from './tools.types';

/**
 * Phase 5.2.2 — the `query_metadata` tool's execution logic.
 *
 * A self-managed capability tool that wraps `MetadataQueryService.aggregate()`
 * (Phase 5.1, exact episode-grained aggregations). The model speaks a FLAT schema
 * (`{ type, field?, value?, limit? }` — Gemini can't reliably fill discriminated
 * unions); this service maps it to the strict `MetadataQueryRequest` union and
 * lets the metadata service enforce the keyword↔numeric allow-lists (fail-loud).
 *
 * Symmetric to `SearchContentToolService`: returns `{ result, summary }`.
 *
 * This is the executable function + output shaping ONLY — binding to Gemini
 * (`bindTools`) and routing are Phase 5.3, no LLM here.
 *
 * Exception policy (locked): malformed flat input → `InvalidToolInputException`;
 * `InvalidMetadataQueryException` (bad field/type pairing) is RE-WRAPPED to
 * `InvalidToolInputException` (uniform "the model gave bad args" signal for the
 * 5.3 router); `MetadataQueryFailedException` (infra/500) PROPAGATES untouched
 * — exactness is never silently degraded.
 */
@Injectable()
export class QueryMetadataToolService {
  private readonly logger = new Logger(QueryMetadataToolService.name);

  constructor(private readonly metadataQueryService: MetadataQueryService) {}

  async execute(input: QueryMetadataInput): Promise<QueryMetadataResult> {
    const parsed = queryMetadataInputSchema.safeParse(this.applyCountAllTolerance(input));
    if (!parsed.success) {
      throw new InvalidToolInputException(
        `query_metadata: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    const request = this.toRequest(parsed.data);
    const startTime = Date.now();
    let result: MetadataQueryResult;
    try {
      result = await this.metadataQueryService.aggregate(request);
    } catch (error) {
      // Bad field/type pairing (e.g. avg on a keyword field) → uniform bad-args
      // signal. Infra failures (MetadataQueryFailedException) propagate fail-loud.
      if (error instanceof InvalidMetadataQueryException) {
        throw new InvalidToolInputException(`query_metadata: ${error.message}`);
      }
      throw error;
    }

    const summary = this.summarize(result);
    this.logger.log(
      `query_metadata type=${request.type} duration_ms=${Date.now() - startTime} ` +
        `summary="${summary}"`,
    );
    return { result, summary };
  }

  /**
   * Count-all tolerance (Phase 5.3.4 — adapter-only, scoped).
   *
   * The model sometimes attaches a `field` to a whole-collection `count` (e.g.
   * `{type:'count', field:'episode_id'}`) with NO `value`. Semantically that is a
   * count of ALL episodes, not a filter — but `field` without `value` violates the
   * strict `count` all-or-nothing rule and would 400. We drop the orphan `field`
   * so it maps to count-all instead of erroring. Scoped to `count` ONLY — for every
   * other type `field` is the operand (not a filter) and must be preserved. This
   * normalizes the INPUT before strict validation; the strict schema and
   * `MetadataQueryService` contract are NOT relaxed (a direct
   * `queryMetadataInputSchema.safeParse` of the same shape still rejects it).
   */
  private applyCountAllTolerance(input: QueryMetadataInput): QueryMetadataInput {
    if (
      input.type === MetadataAggregation.COUNT &&
      input.field !== undefined &&
      input.value === undefined
    ) {
      const { field: _droppedField, ...countAll } = input;
      return countAll;
    }
    return input;
  }

  /**
   * Map the flat LLM input to the strict `MetadataQueryRequest` union. The field
   * casts are safe: `.superRefine` guaranteed presence, and the metadata service
   * validates the keyword↔numeric pairing at runtime.
   */
  private toRequest(input: QueryMetadataInput): MetadataQueryRequest {
    const { type, field, value, limit } = input;
    switch (type) {
      case MetadataAggregation.COUNT:
        return field !== undefined && value !== undefined
          ? { type, filter: { field: field as KeywordField, value } }
          : { type };
      case MetadataAggregation.COUNT_DISTINCT:
        return { type, field: field as KeywordField };
      case MetadataAggregation.FILTER:
        return {
          type,
          field: field as KeywordField,
          value: value as string,
          ...(limit !== undefined ? { limit } : {}),
        };
      case MetadataAggregation.MIN:
      case MetadataAggregation.MAX:
        return { type, field: field as NumericField };
      case MetadataAggregation.AVG:
        return { type, field: field as NumericField };
      case MetadataAggregation.GROUP_BY:
        return {
          type,
          field: field as KeywordField,
          ...(limit !== undefined ? { size: limit } : {}),
        };
    }
  }

  /** One-line natural-language rendering of the aggregation result (LLM-facing). */
  private summarize(result: MetadataQueryResult): string {
    switch (result.type) {
      case MetadataAggregation.COUNT:
        return result.filter
          ? `${result.value} episode(s) match ${result.filter.field} = "${result.filter.value}".`
          : `There are ${result.value} episodes.`;
      case MetadataAggregation.COUNT_DISTINCT:
        return `There are ${result.value} distinct ${result.field} values.`;
      case MetadataAggregation.FILTER: {
        if (result.count === 0) return `No episodes match ${result.field} = "${result.value}".`;
        const shown = result.episodes.map((e) => `"${e.title}" (ep ${e.episodeId})`).join(', ');
        const more = result.count > result.episodes.length ? ' …' : '';
        return `${result.count} episode(s) match ${result.field} = "${result.value}": ${shown}${more}`;
      }
      case MetadataAggregation.MIN:
      case MetadataAggregation.MAX: {
        if (result.value === null) return `No ${result.field} data available.`;
        const which = result.type === MetadataAggregation.MIN ? 'minimum' : 'maximum';
        const where = result.episode
          ? ` (episode "${result.episode.title}", ep ${result.episode.episodeId})`
          : '';
        return `The ${which} ${result.field} is ${result.value}${where}.`;
      }
      case MetadataAggregation.AVG:
        return result.value === null
          ? `No ${result.field} data available.`
          : `The average ${result.field} is ${Math.round(result.value * 100) / 100}.`;
      case MetadataAggregation.GROUP_BY: {
        if (result.buckets.length === 0) return `No ${result.field} groups found.`;
        const top = result.buckets.map((b) => `${b.key} (${b.count})`).join(', ');
        return `Top ${result.field} by episode count: ${top}.`;
      }
    }
  }
}
