export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  windowMs: number;
  openDurationMs: number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: Date | null;
  openedAt: Date | null;
  willCloseAt: Date | null;
}
