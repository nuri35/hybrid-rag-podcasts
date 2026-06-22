import { z } from 'zod';
import { MetadataAggregation } from '../metadata/metadata.types';
import { QUERY_METADATA_FIELDS } from './tools.constants';

/**
 * Gemini-facing **binding-safe** schema for `query_metadata` (Phase 5.3.1).
 *
 * The schema bound to the model via `bindTools` — NOT the runtime trust boundary.
 * Two deliberate differences from the strict `queryMetadataInputSchema`:
 *   1. `limit` is a plain `z.number()` WITHOUT `.int()/.positive()` — those emit
 *      `exclusiveMinimum`, which Gemini's FunctionDeclaration subset rejects (400,
 *      verified in 5.3 Step-0).
 *   2. No `.superRefine` — the per-`type` requiredness (field/value) adds no
 *      JSON-Schema constraint the model sees anyway; it is enforced at runtime by
 *      the strict schema + `MetadataQueryService` (fail-loud trust boundary).
 *
 * The enum vocabulary (`type`, `field`) is shared with the strict schema via the
 * same `MetadataAggregation` / `QUERY_METADATA_FIELDS` constants, so the bound
 * vocabulary cannot drift. The strict `queryMetadataInputSchema` is UNCHANGED and
 * still runs inside `QueryMetadataToolService.execute()`.
 */
export const queryMetadataBindingSchema = z.object({
  type: z
    .nativeEnum(MetadataAggregation)
    .describe(
      'The aggregation to run: count (episode count), count_distinct (distinct ' +
        'values of a field), filter (episodes where field == value), min / max / ' +
        'avg (over a numeric field), group_by (episode count per value of a field).',
    ),
  field: z
    .enum(QUERY_METADATA_FIELDS)
    .optional()
    .describe(
      'The metadata field to operate on. Keyword fields (episode_id, guest_name, ' +
        'title) for count_distinct/filter/group_by; the numeric field duration_min ' +
        'for min/max/avg. For count it is the OPTIONAL filter field (omit both field ' +
        'and value to count ALL episodes).',
    ),
  value: z
    .string()
    .optional()
    .describe(
      'Exact value to match (keyword equality). Required for filter; optional for ' +
        'count (counts episodes where field == value).',
    ),
  limit: z
    .number()
    .optional()
    .describe(
      'For group_by: number of buckets to return (default 10). For filter: max ' +
        'episodes to list (default 50). Ignored for other types.',
    ),
});

export type QueryMetadataBindingInput = z.infer<typeof queryMetadataBindingSchema>;
