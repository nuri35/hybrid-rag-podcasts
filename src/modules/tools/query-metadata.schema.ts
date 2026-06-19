import { z } from 'zod';
import { MetadataAggregation } from '../metadata/metadata.types';
import { QUERY_METADATA_FIELDS } from './tools.constants';

/**
 * LLM-facing input schema for `query_metadata` (Phase 5.2.2).
 *
 * **FLAT, not the discriminated union.** `@langchain/google-genai`'s converter
 * passes `anyOf`/`oneOf` straight through to Gemini's function `parameters`
 * (an OBJECT-with-properties subset), so a Zod union is unreliable for function
 * calling. We expose a single flat object with an enum `type` discriminator and
 * optional fields, then map it to the strict `MetadataQueryRequest` union in the
 * service. See PHASE_5_2_PLAN.md Part 3 §B.
 *
 * `type`/`field` are enums (constrain the vocabulary); `.superRefine` enforces
 * per-`type` requiredness. The keyword↔numeric pairing (e.g. `avg` needs a
 * numeric field) is NOT encoded here — `MetadataQueryService` enforces it at
 * runtime (fail-loud trust boundary).
 */
export const queryMetadataInputSchema = z
  .object({
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
          'for min/max/avg. For count it is the OPTIONAL filter field.',
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
      .int()
      .positive()
      .optional()
      .describe(
        'For group_by: number of buckets to return (default 10). For filter: max ' +
          'episodes to list (default 50). Ignored for other types.',
      ),
  })
  .superRefine((data, ctx) => {
    // field is required for every type except count.
    if (data.type !== MetadataAggregation.COUNT && data.field === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `field is required for type "${data.type}"`,
        path: ['field'],
      });
    }
    // filter needs a value.
    if (
      data.type === MetadataAggregation.FILTER &&
      (data.value === undefined || data.value.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'value is required for type "filter"',
        path: ['value'],
      });
    }
    // count's optional filter is all-or-nothing.
    if (
      data.type === MetadataAggregation.COUNT &&
      (data.field === undefined) !== (data.value === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'count filter requires both field and value (or neither)',
        path: ['value'],
      });
    }
  });

export type QueryMetadataInput = z.infer<typeof queryMetadataInputSchema>;
