import { describe, expect, it } from 'vitest';
import { clientIp, FixedWindowRateLimiter } from './follow-rate-limiter.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit per key per window, then blocks with a retry hint', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);
    now += 20_000;
    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(40);
    // other keys are independent
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('starts a fresh window once the old one has expired', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1, 1_000, () => now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    now = 1_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('sweeps expired keys so memory does not grow without bound', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(5, 1_000, () => now);
    for (let i = 0; i < 50; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size).toBe(50);
    now = 5_000;
    limiter.hit('fresh');
    expect(limiter.size).toBe(1);
  });
});

describe('clientIp', () => {
  const req = (xff: string | string[] | undefined, ip = '127.0.0.1') =>
    ({ ip, headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' } }) as never;

  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientIp(req('1.2.3.4'), false)).toBe('127.0.0.1');
  });

  it('uses the last (proxy-appended, unforgeable) X-Forwarded-For entry when trusted', () => {
    expect(clientIp(req('6.6.6.6, 1.2.3.4'), true)).toBe('1.2.3.4');
    expect(clientIp(req(['6.6.6.6', '1.2.3.4']), true)).toBe('1.2.3.4');
  });

  it('falls back to req.ip / the socket address', () => {
    expect(clientIp(req(undefined), true)).toBe('127.0.0.1');
    expect(clientIp({ ip: undefined, headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never, false)).toBe('10.0.0.1');
  });
});
