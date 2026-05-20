import { ApiProperty } from '@nestjs/swagger';

export class QaSourceDto {
  @ApiProperty({
    description: 'Unique identifier of the source chunk',
    example: '14_chunk_5',
  })
  chunkId!: string;

  @ApiProperty({
    description: 'Cosine similarity score (0 to 1, higher is more relevant)',
    example: 0.92,
  })
  score!: number;

  @ApiProperty({
    description: 'First 200 characters of the source chunk',
    example: 'And so consciousness, in my view, emerges from the integration...',
  })
  excerpt!: string;

  @ApiProperty({
    description: 'Chunk metadata (episode_id, source, etc.)',
    type: Object,
    additionalProperties: true,
  })
  metadata!: Record<string, unknown>;
}

export class QaResponseDto {
  @ApiProperty({
    description: 'Answer generated from podcast context',
    example: 'Consciousness is subjective experience...',
  })
  answer!: string;

  @ApiProperty({
    description: 'Source chunks used to generate the answer',
    type: [QaSourceDto],
  })
  sources!: QaSourceDto[];
}
