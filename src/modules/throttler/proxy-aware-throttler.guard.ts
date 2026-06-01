import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard that derives the rate-limit tracker from the real client IP
 * when the app runs behind a load balancer / reverse proxy.
 *
 * `req.ip` reflects the immediate peer — behind a proxy that is the proxy's
 * address, so every client would share one bucket. With `trust proxy` enabled
 * (see main.ts) Express populates `X-Forwarded-For`; its first entry is the
 * originating client. We read that, falling back to `req.ip`, then to a
 * literal `'unknown'` so a missing IP degrades to a single shared bucket
 * rather than throwing.
 *
 * The `getTracker` signature mirrors the base class exactly
 * (`req: Record<string, any>`); the `any` is inherited from the library
 * interface, not introduced here.
 */
@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getTracker(req: Record<string, any>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, unknown>;
    const forwarded: unknown = headers['x-forwarded-for'];

    // Most common case: proxies set a single string, possibly a
    // comma-separated chain "client, proxy1, proxy2" — the client is first.
    if (typeof forwarded === 'string') {
      const firstIp = forwarded.split(',')[0]?.trim();
      if (firstIp) return Promise.resolve(firstIp);
    }

    // Multiple X-Forwarded-For headers collapse to a string[]; the first
    // element holds the earliest hop (still potentially a comma chain).
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      const firstIp = String(forwarded[0]).split(',')[0]?.trim();
      if (firstIp) return Promise.resolve(firstIp);
    }

    const ip: unknown = req.ip;
    return Promise.resolve(typeof ip === 'string' && ip.length > 0 ? ip : 'unknown');
  }
}
