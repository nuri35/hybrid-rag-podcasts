export class CsvValidationException extends Error {
  constructor(
    public readonly rowIndex: number,
    public readonly reason: string,
  ) {
    super(`CSV row ${rowIndex} failed validation: ${reason}`);
    this.name = 'CsvValidationException';
  }
}
