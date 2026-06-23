import { ApiProperty } from '@nestjs/swagger';
import { QaSourceDto, RetrievalMetadataDto } from './qa-response.dto';

/**
 * Which pipeline produced the answer (Phase 5.4).
 *   - `direct`   → classic Phase 4 RAG (retrieve → ground → generate).
 *   - `tool_use` → single-shot LLM tool routing (search_content / query_metadata).
 */
export type AnswerPath = 'direct' | 'tool_use';

/**
 * Unified QA response (Phase 5.4) returned by `POST /api/v1/questions` regardless
 * of which path ran. A **superset** of the legacy direct-path body — `answer` and
 * `sources` are always present, so existing clients are unaffected; the new fields
 * are additive.
 *
 * - `sources` is the cited chunks on the direct path, and **`[]` on the tool-use
 *   path** (the router consumes tool results internally and surfaces no chunk
 *   citations — Phase 5.4 §4 gap).
 * - `retrievalMetadata` is direct-path-only (the pre-expansion fused top-K, for eval).
 * - `toolUsed` / `latency` are tool-use-path-only.
 * - `path` is always present so callers can tell which pipeline answered.
 */
export class AnswerResponseDto {
  @ApiProperty({
    description:
      'Generated answer string, grounded in the retrieved sources (direct) or the tool results (tool-use).',
    example: 'Consciousness, according to several guests on the podcast, is understood as...',
  })
  answer!: string;

  @ApiProperty({
    description:
      'Cited source chunks. The (expanded) chunks the LLM saw on the direct path; ' +
      'ALWAYS empty ([]) on the tool-use path (the router surfaces no chunk citations).',
    type: [QaSourceDto],
  })
  sources!: QaSourceDto[];

  @ApiProperty({
    description:
      'Direct-path-only retrieval metadata (pre-expansion fused top-K) for evaluation. ' +
      'Omitted on the tool-use path, on cache hits, and on the empty-retrieval fast path.',
    type: RetrievalMetadataDto,
    required: false,
  })
  retrievalMetadata?: RetrievalMetadataDto;

  @ApiProperty({
    description:
      'Tool-use-path-only: the tool(s) the model invoked this turn (in order). Omitted on the direct path.',
    type: [String],
    required: false,
    example: ['query_metadata'],
  })
  toolUsed?: string[];

  @ApiProperty({
    description:
      'Tool-use-path-only: wall-clock ms of the router round. Omitted on the direct path.',
    required: false,
    example: 842,
  })
  latency?: number;

  @ApiProperty({
    description:
      "Which pipeline produced the answer: 'direct' (classic RAG) or 'tool_use' (LLM tool routing).",
    enum: ['direct', 'tool_use'],
    example: 'direct',
  })
  path!: AnswerPath;
}
