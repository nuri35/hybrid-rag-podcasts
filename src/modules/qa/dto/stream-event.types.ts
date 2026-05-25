import type { QaSourceDto } from './qa-response.dto';

/**
 * Phase 1.6 Sprint Streaming — wire-format types for the SSE event
 * stream emitted by `POST /api/v1/questions/stream`.
 *
 * Event ordering contract:
 *   1. exactly one `sources` event (possibly empty array) — emitted
 *      BEFORE any `token` event so the client can render citations
 *      alongside the streaming answer
 *   2. zero or more `token` events
 *   3. exactly one terminator — either `done` (happy path) or
 *      `error` (unrecoverable mid-stream failure)
 *
 * Heartbeat events (typed `{ type: 'heartbeat' }`) are emitted by the
 * controller's RxJS merge layer, NOT by `QaChainService.askStream`,
 * so they are intentionally NOT part of this union — keeping the
 * service-layer contract focused on payload-bearing events. Clients
 * receive heartbeats as `data: {"type":"heartbeat"}` SSE lines and
 * should treat them as no-ops.
 */
export type StreamEventType = 'sources' | 'token' | 'done' | 'error';

export interface StreamEventSources {
  type: 'sources';
  data: QaSourceDto[];
}

export interface StreamEventToken {
  type: 'token';
  data: string;
}

export interface StreamEventDone {
  type: 'done';
  data: {
    totalChunks: number;
  };
}

export interface StreamEventError {
  type: 'error';
  data: {
    code: string;
    message: string;
  };
}

export type StreamEvent =
  | StreamEventSources
  | StreamEventToken
  | StreamEventDone
  | StreamEventError;
