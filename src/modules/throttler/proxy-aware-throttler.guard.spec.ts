import type { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';

/**
 * Subclass exposing the protected `getTracker` so the IP-extraction logic
 * can be exercised in isolation. The guard's constructor dependencies
 * (options / storage / reflector) are irrelevant to `getTracker`, so they
 * are passed as minimal stubs.
 */
class TestableGuard extends ProxyAwareThrottlerGuard {
  track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

function makeGuard(): TestableGuard {
  return new TestableGuard([] as ThrottlerModuleOptions, {} as ThrottlerStorage, {} as Reflector);
}

describe('ProxyAwareThrottlerGuard.getTracker', () => {
  let guard: TestableGuard;

  beforeEach(() => {
    guard = makeGuard();
  });

  it('returns the IP from a single-value X-Forwarded-For header', async () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.7' }, ip: '10.0.0.1' };
    await expect(guard.track(req)).resolves.toBe('203.0.113.7');
  });

  it('returns the first (client) IP from a comma-separated X-Forwarded-For chain', async () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' },
      ip: '10.0.0.1',
    };
    await expect(guard.track(req)).resolves.toBe('203.0.113.7');
  });

  it('returns the first IP when X-Forwarded-For arrives as a string array', async () => {
    const req = {
      headers: { 'x-forwarded-for': ['203.0.113.7, 70.41.3.18', '8.8.8.8'] },
      ip: '10.0.0.1',
    };
    await expect(guard.track(req)).resolves.toBe('203.0.113.7');
  });

  it('falls back to req.ip when there is no X-Forwarded-For header', async () => {
    const req = { headers: {}, ip: '10.0.0.1' };
    await expect(guard.track(req)).resolves.toBe('10.0.0.1');
  });

  it("returns 'unknown' when both the header and req.ip are absent", async () => {
    const req = { headers: {} };
    await expect(guard.track(req)).resolves.toBe('unknown');
  });

  it('trims surrounding whitespace from the extracted IP', async () => {
    const req = { headers: { 'x-forwarded-for': '   203.0.113.7   ' }, ip: '10.0.0.1' };
    await expect(guard.track(req)).resolves.toBe('203.0.113.7');
  });
});
