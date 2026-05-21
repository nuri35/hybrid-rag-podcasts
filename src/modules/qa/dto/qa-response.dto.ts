import { ApiProperty } from '@nestjs/swagger';

export class QaSourceDto {
  @ApiProperty({
    description:
      'Stable identifier of the source chunk in the vector store. ' +
      'Format: <episode_id>_chunk_<chunk_index>.',
    example: '14_chunk_5',
  })
  chunkId!: string;

  @ApiProperty({
    description:
      'Cosine-similarity-equivalent score in [0, 1]. Higher means more semantically ' +
      'similar to the question. Computed as 1 - L²/2 over unit-normalized vectors.',
    example: 0.92,
    minimum: 0,
    maximum: 1,
  })
  score!: number;

  @ApiProperty({
    description:
      'First 200 characters of the chunk text. Full text is not returned to keep ' +
      'response payloads small. Truncated excerpts end with "..." when the original ' +
      'text exceeds 200 chars.',
    example: 'And so consciousness, in my view, emerges from the integration...',
  })
  excerpt!: string;

  @ApiProperty({
    description:
      'Chunk metadata from ingestion. Includes episode_id, chunk_index, source. ' +
      'Shape may evolve in future phases — treat as an opaque dictionary.',
    type: Object,
    additionalProperties: true,
    example: {
      episode_id: '14',
      chunk_index: 5,
      source: 'Lex Fridman Podcast',
    },
  })
  metadata!: Record<string, unknown>;
}

export class QaResponseDto {
  @ApiProperty({
    description:
      'Generated answer string. Grounded in the retrieved sources per the QA chain prompt. ' +
      'If retrieval returns no chunks or the LLM determines the context is insufficient, ' +
      'the response is the canned "I don\'t have enough information to answer this question." string.',
    example: 'Consciousness, according to several guests on the podcast, is understood as...',
  })
  answer!: string;

  @ApiProperty({
    description:
      'Array of source chunks cited by the answer. Empty when retrieval returned no chunks ' +
      'or when the fast-path no-info response fires. Order reflects retrieval ranking ' +
      '(highest score first).',
    type: [QaSourceDto],
  })
  sources!: QaSourceDto[];
}
