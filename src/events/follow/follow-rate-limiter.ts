import type { Request } from 'express';

/** Tiny in-memory fixed-window rate limiter (no dependency). One instance per protected route
 * family; keyed by whatever the caller passes (the client IP). Expired windows are swept lazily on
 * the next hit, so there is no timer to leak and memory stays proportional to recent clients. */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request for `key`. `retryAfterSeconds` is only meaningful when not allowed. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    this.sweep(now);
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= this.limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  /** Number of tracked keys (for tests / diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.windowMs;
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }
}

/** The caller's address for rate limiting. The app does not enable Express "trust proxy", so by
 * default this is req.ip (behind nginx that would be 127.0.0.1 for everyone). Set
 * FOLLOW_TRUST_PROXY=true when running behind a single trusted reverse proxy that appends the
 * client to X-Forwarded-For (nginx `$proxy_add_x_forwarded_for`): the LAST entry is the one the
 * proxy added, which a client cannot forge. */
export function clientIp(req: Pick<Request, 'ip' | 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers?.['x-forwarded-for'];
    const raw = Array.isArray(header) ? header.join(',') : header;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
