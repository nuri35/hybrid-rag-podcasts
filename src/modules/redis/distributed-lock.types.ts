/**
 * Options for acquiring a distributed lock.
 *
 * `ownerId` is optional — when omitted, the service generates a unique id
 * (`{pid}-{uuid}`) per acquire call. Passing your own is useful for tests
 * and for callers that want a recognisable owner string in logs.
 */
export interface LockOptions {
  ttlSeconds: number;
  ownerId?: string;
}

/**
 * Outcome of an acquire attempt.
 *
 * On `acquired: true` the caller MUST keep `ownerId` and pass it to every
 * subsequent `release`/`refresh` call — the owner-check is what prevents
 * a different process from accidentally releasing the lock.
 *
 * On `acquired: false` everything except `key` is null.
 */
export interface LockResult {
  acquired: boolean;
  ownerId: string | null;
  key: string;
  expiresAt: Date | null;
}
