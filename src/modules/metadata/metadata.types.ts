import type { KEYWORD_FIELDS, NUMERIC_FIELDS } from './metadata.constants';

/**
 * Closed set of aggregation operations (Phase 5.1). Maps 1:1 to the future
 * `query_metadata` tool's `aggregation_type` argument (5.2).
 */
export enum MetadataAggregation {
  COUNT = 'count',
  COUNT_DISTINCT = 'count_distinct',
  FILTER = 'filter',
  MIN = 'min',
  MAX = 'max',
  AVG = 'avg',
  GROUP_BY = 'group_by',
}

/** Keyword fields (count/count_distinct/filter/group_by). */
export type KeywordField = (typeof KEYWORD_FIELDS)[number];
/** Numeric fields (min/max/avg). */
export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** A lightweight episode reference returned by filter() and min/max(). */
export interface EpisodeRef {
  episodeId: string;
  title: string;
  guestName: string;
}

/**
 * Typed aggregation request — a discriminated union on `type`. The union
 * enforces field-category correctness at compile time for internal callers; the
 * service ALSO validates at runtime, because the 5.2 tool feeds untyped LLM input.
 */
export type MetadataQueryRequest =
  | { type: MetadataAggregation.COUNT; filter?: { field: KeywordField; value: string } }
  | { type: MetadataAggregation.COUNT_DISTINCT; field: KeywordField }
  | { type: MetadataAggregation.FILTER; field: KeywordField; value: string; limit?: number }
  | { type: MetadataAggregation.MIN | MetadataAggregation.MAX; field: NumericField }
  | { type: MetadataAggregation.AVG; field: NumericField }
  | { type: MetadataAggregation.GROUP_BY; field: KeywordField; size?: number };

export interface CountResult {
  type: MetadataAggregation.COUNT;
  value: number;
  filter?: { field: string; value: string };
}
export interface CountDistinctResult {
  type: MetadataAggregation.COUNT_DISTINCT;
  field: string;
  value: number;
}
export interface FilterResult {
  type: MetadataAggregation.FILTER;
  field: string;
  value: string;
  count: number;
  episodes: EpisodeRef[];
}
export interface ExtremeResult {
  type: MetadataAggregation.MIN | MetadataAggregation.MAX;
  field: string;
  value: number | null;
  episode: EpisodeRef | null;
}
export interface AvgResult {
  type: MetadataAggregation.AVG;
  field: string;
  value: number | null;
}
export interface GroupByResult {
  type: MetadataAggregation.GROUP_BY;
  field: string;
  buckets: Array<{ key: string; count: number }>;
}

export type MetadataQueryResult =
  | CountResult
  | CountDistinctResult
  | FilterResult
  | ExtremeResult
  | AvgResult
  | GroupByResult;
