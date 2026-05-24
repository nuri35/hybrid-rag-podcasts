/**
 * Retry classification tables used by RetryPolicyService.
 *
 * Retryable = transient: rate limit, server hiccup, network blip. Retrying
 * has a real chance of succeeding without operator action.
 * Non-retryable = persistent: bad input, broken credentials, deprecated
 * endpoint. Retrying just amplifies the failure mode.
 *
 * 500 is included as retryable on the assumption it usually reflects a
 * transient backend hiccup; a 500 caused by a malformed request is rarer
 * than the wire would suggest in practice.
 */

export const RETRYABLE_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export const RETRYABLE_NODE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export const RETRYABLE_ERROR_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /rate.?limit/i,
  /timeout/i,
  /temporarily unavailable/i,
  /connection.*reset/i,
];
