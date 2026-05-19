export class ChromaUnreachableException extends Error {
  constructor(
    public readonly url: string,
    public readonly underlyingError: string,
  ) {
    super(
      `Chroma server at ${url} is unreachable: ${underlyingError}. ` +
        `Check CHROMA_URL and ensure the server is running.`,
    );
    this.name = 'ChromaUnreachableException';
  }
}
