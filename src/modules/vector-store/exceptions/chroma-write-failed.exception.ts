export interface FailedBatch {
  index: number;
  reason: string;
}

export class ChromaWriteFailedException extends Error {
  constructor(
    public readonly writtenBatches: number,
    public readonly failedBatches: FailedBatch[],
    public readonly totalBatches: number,
  ) {
    super(
      `Chroma write failed: ${failedBatches.length}/${totalBatches} batch(es) rejected after retries; ${writtenBatches} succeeded`,
    );
    this.name = 'ChromaWriteFailedException';
  }
}
