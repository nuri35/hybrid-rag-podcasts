import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';
import { CircuitState } from '../types/circuit-breaker.types';

/**
 * Phase 1.7.5 Sprint Distributed-Breaker.
 *
 * Owns the Redis side of the circuit breaker: five keys under
 * `circuit:llm:` holding the shared state machine, plus three Lua scripts
 * that perform every multi-step transition atomically so concurrent
 * instances can never race on a read-modify-write.
 *
 *   circuit:llm:state                 string  CLOSED | OPEN | HALF_OPEN (absent = CLOSED)
 *   circuit:llm:failure_timestamps    zset    failure events scored by ms epoch
 *   circuit:llm:opened_at             string  ms epoch of the last OPEN transition
 *   circuit:llm:half_open_probe_token string  single-flight probe lock (SET NX PX)
 *   circuit:llm:state_changed_at      string  ms epoch of the last transition (diagnostics)
 *
 * Keys are passed in a fixed KEYS[1..5] order to every EVAL so the scripts
 * stay Redis-Cluster-compatible (all keys hash to one slot if we ever add a
 * `{circuit:llm}` hash tag). Every script PEXPIREs the keys it touches with
 * `max(windowMs, openDurationMs) * 4` so a long idle period can't leave a
 * stale OPEN circuit wedged forever.
 *
 * This class never swallows Redis errors — the caller (CircuitBreakerService)
 * owns the fail-open decision. It only defends against malformed/empty Redis
 * RETURN values by resolving them to the safe CLOSED default.
 */

const KEY_PREFIX = 'circuit:llm:';

/** Fixed KEYS[1..5] order shared by all three scripts. */
export const CIRCUIT_KEYS: string[] = [
  `${KEY_PREFIX}state`,
  `${KEY_PREFIX}failure_timestamps`,
  `${KEY_PREFIX}opened_at`,
  `${KEY_PREFIX}half_open_probe_token`,
  `${KEY_PREFIX}state_changed_at`,
];

export interface ProbeAcquisitionResult {
  /** Resolved circuit state after evaluation (and possible HALF_OPEN promotion). */
  state: CircuitState;
  /** True if THIS caller atomically acquired the single half-open probe slot. */
  acquiredProbe: boolean;
  /** Milliseconds until the next probe is allowed (only meaningful when OPEN). */
  retryAfterMs: number;
}

export interface CircuitStateSnapshot {
  state: CircuitState;
  failureCount: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
}

/**
 * Read state, prune the failure window, and decide whether the caller may
 * proceed. The probe token (SET NX) is the single-flight gate:
 *   - CLOSED                          → proceed
 *   - OPEN, still cooling down        → blocked, retryAfterMs = remaining
 *   - OPEN cooled down, or HALF_OPEN  → try SET NX:
 *        won  → promote/keep HALF_OPEN, caller IS the probe-holder
 *        lost → a probe is already in flight elsewhere → blocked as OPEN
 * Returns [state, acquiredProbe(0|1), retryAfterMs]. Treating HALF_OPEN via
 * the same SET NX gate means a probe-holder that crashed (token TTL expires)
 * self-heals: the next caller wins a fresh probe instead of the circuit
 * wedging in HALF_OPEN.
 */
export const EVALUATE_AND_ACQUIRE_PROBE_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local openDurationMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

-- Drop failures that have aged out of the rolling window.
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - windowMs)

local state = redis.call('GET', KEYS[1]) or 'CLOSED'
local openedAt = tonumber(redis.call('GET', KEYS[3])) or 0

local result
if state == 'CLOSED' then
  result = {'CLOSED', 0, 0}
else
  local elapsed = now - openedAt
  if state == 'OPEN' and elapsed < openDurationMs then
    -- Still cooling down.
    result = {'OPEN', 0, openDurationMs - elapsed}
  else
    -- Cool-down elapsed (OPEN) or already HALF_OPEN: single-flight probe gate.
    local acquired = redis.call('SET', KEYS[4], '1', 'NX', 'PX', openDurationMs)
    if acquired then
      redis.call('SET', KEYS[1], 'HALF_OPEN')
      redis.call('SET', KEYS[5], now)
      result = {'HALF_OPEN', 1, 0}
    else
      -- A probe is already in flight on another instance/caller.
      result = {'OPEN', 0, openDurationMs}
    end
  end
end

-- Refresh TTLs so live state survives activity but stale state self-expires.
redis.call('PEXPIRE', KEYS[1], ttlMs)
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], ttlMs) end
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('PEXPIRE', KEYS[3], ttlMs) end
if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('PEXPIRE', KEYS[4], ttlMs) end
if redis.call('EXISTS', KEYS[5]) == 1 then redis.call('PEXPIRE', KEYS[5], ttlMs) end

return result
`;

/**
 * Record a failure: add to the window, prune, then transition to OPEN if
 * either (a) we were the HALF_OPEN probe (probe failed) or (b) the failure
 * count reached the threshold. Returns the resulting state string.
 */
export const RECORD_FAILURE_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local failureThreshold = tonumber(ARGV[3])
local openDurationMs = tonumber(ARGV[4])
local member = ARGV[5]
local ttlMs = tonumber(ARGV[6])

redis.call('ZADD', KEYS[2], now, member)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - windowMs)

local currentState = redis.call('GET', KEYS[1]) or 'CLOSED'
local newState

if currentState == 'HALF_OPEN' then
  -- Probe failed → straight back to OPEN, re-arm the cool-down, drop the probe.
  redis.call('SET', KEYS[1], 'OPEN')
  redis.call('SET', KEYS[3], now)
  redis.call('SET', KEYS[5], now)
  redis.call('DEL', KEYS[4])
  newState = 'OPEN'
else
  local failureCount = redis.call('ZCARD', KEYS[2])
  if failureCount >= failureThreshold and currentState ~= 'OPEN' then
    redis.call('SET', KEYS[1], 'OPEN')
    redis.call('SET', KEYS[3], now)
    redis.call('SET', KEYS[5], now)
    newState = 'OPEN'
  else
    newState = currentState
  end
end

redis.call('PEXPIRE', KEYS[1], ttlMs)
redis.call('PEXPIRE', KEYS[2], ttlMs)
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('PEXPIRE', KEYS[3], ttlMs) end
if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('PEXPIRE', KEYS[4], ttlMs) end
if redis.call('EXISTS', KEYS[5]) == 1 then redis.call('PEXPIRE', KEYS[5], ttlMs) end

return newState
`;

/**
 * A HALF_OPEN probe succeeded: reset the circuit to the implicit-CLOSED
 * baseline by deleting ALL five keys (absence of the state key == CLOSED).
 * Full DEL leaves no lingering keys, so this path needs neither ARGV nor a
 * TTL. No-op when not HALF_OPEN. Always returns 'CLOSED'.
 */
export const RECORD_PROBE_SUCCESS_LUA = `
local currentState = redis.call('GET', KEYS[1]) or 'CLOSED'

if currentState == 'HALF_OPEN' then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])
end

return 'CLOSED'
`;

/**
 * Read-only snapshot for diagnostics / health: prune the window, then return
 * [state, failureCount, openedAt|'0', lastFailureScore|'0']. Does not mutate
 * state beyond the standard window prune.
 */
export const READ_SNAPSHOT_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - windowMs)

local state = redis.call('GET', KEYS[1]) or 'CLOSED'
local failureCount = redis.call('ZCARD', KEYS[2])
local openedAt = redis.call('GET', KEYS[3]) or '0'

local lastScore = '0'
local last = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
if last[2] ~= nil then lastScore = last[2] end

return {state, failureCount, openedAt, lastScore}
`;

@Injectable()
export class CircuitBreakerRedisStorage {
  constructor(private readonly redisService: RedisService) {}

  async evaluateAndAcquireProbe(
    windowMs: number,
    openDurationMs: number,
  ): Promise<ProbeAcquisitionResult> {
    const now = Date.now();
    const ttlMs = this.computeTtlMs(windowMs, openDurationMs);
    const raw = await this.redisService.eval(EVALUATE_AND_ACQUIRE_PROBE_LUA, CIRCUIT_KEYS, [
      String(now),
      String(windowMs),
      String(openDurationMs),
      String(ttlMs),
    ]);
    return this.parseProbeResult(raw);
  }

  async recordFailure(
    failureThreshold: number,
    windowMs: number,
    openDurationMs: number,
  ): Promise<CircuitState> {
    const now = Date.now();
    const ttlMs = this.computeTtlMs(windowMs, openDurationMs);
    // Unique sorted-set member: identical ms timestamps (same or different
    // instance) would otherwise collide on ZADD and undercount failures.
    const member = `${now}-${randomUUID()}`;
    const raw = await this.redisService.eval(RECORD_FAILURE_LUA, CIRCUIT_KEYS, [
      String(now),
      String(windowMs),
      String(failureThreshold),
      String(openDurationMs),
      member,
      String(ttlMs),
    ]);
    return this.parseState(raw);
  }

  async recordProbeSuccess(): Promise<void> {
    // Full reset to the implicit-CLOSED baseline (all keys DELeted), so no
    // timestamp or TTL argument is required.
    await this.redisService.eval(RECORD_PROBE_SUCCESS_LUA, CIRCUIT_KEYS, []);
  }

  async readSnapshot(windowMs: number): Promise<CircuitStateSnapshot> {
    const now = Date.now();
    const raw = await this.redisService.eval(READ_SNAPSHOT_LUA, CIRCUIT_KEYS, [
      String(now),
      String(windowMs),
    ]);
    return this.parseSnapshot(raw);
  }

  private computeTtlMs(windowMs: number, openDurationMs: number): number {
    return Math.max(windowMs, openDurationMs) * 4;
  }

  private parseProbeResult(raw: unknown): ProbeAcquisitionResult {
    if (!Array.isArray(raw) || raw.length < 3) {
      return { state: CircuitState.CLOSED, acquiredProbe: false, retryAfterMs: 0 };
    }
    return {
      state: this.parseState(raw[0]),
      acquiredProbe: Number(raw[1]) === 1,
      retryAfterMs: Number(raw[2]) > 0 ? Number(raw[2]) : 0,
    };
  }

  private parseState(raw: unknown): CircuitState {
    if (raw === CircuitState.OPEN || raw === CircuitState.HALF_OPEN) {
      return raw;
    }
    return CircuitState.CLOSED;
  }

  private parseSnapshot(raw: unknown): CircuitStateSnapshot {
    if (!Array.isArray(raw) || raw.length < 4) {
      return {
        state: CircuitState.CLOSED,
        failureCount: 0,
        openedAtMs: null,
        lastFailureAtMs: null,
      };
    }
    const openedAt = Number(raw[2]);
    const lastFailure = Number(raw[3]);
    return {
      state: this.parseState(raw[0]),
      failureCount: Number(raw[1]) > 0 ? Number(raw[1]) : 0,
      openedAtMs: openedAt > 0 ? openedAt : null,
      lastFailureAtMs: lastFailure > 0 ? lastFailure : null,
    };
  }
}
