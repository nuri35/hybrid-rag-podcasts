export class EmbeddingFailedException extends Error {
  constructor(
    public readonly fulfilled: number,
    public readonly rejected: number,
    public readonly total: number,
  ) {
    super(`Embedding failed: ${rejected}/${total} batches failed after retries`);
    this.name = 'EmbeddingFailedException';
  }
}
