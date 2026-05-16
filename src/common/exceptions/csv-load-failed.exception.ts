export class CsvLoadFailedException extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(`Failed to load CSV at "${filePath}": ${reason}`);
    this.name = 'CsvLoadFailedException';
  }
}
