export class NotImplementedException extends Error {
  constructor(feature: string) {
    super(`Not implemented: ${feature}`);
    this.name = 'NotImplementedException';
  }
}
