import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  FOLLOW_STATE_LIMIT_PER_MINUTE,
  FOLLOW_STREAM_CONNECT_LIMIT_PER_MINUTE,
  PublicFollowController,
} from './public-follow.controller.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

function setup() {
  const state = { getState: vi.fn().mockResolvedValue({ stintCount: 0 }), resolveTarget: vi.fn().mockResolvedValue({ teamId: 't1', eventId: 'e1' }) };
  const streams = { open: vi.fn().mockReturnValue('observable') };
  const controller = new PublicFollowController(state as never, streams as never);
  const req = (ip: string, xff?: string) => ({ ip, headers: xff ? { 'x-forwarded-for': xff } : {}, socket: {} }) as never;
  const res = () => {
    const headers: Record<string, string> = {};
    return { headers, setHeader: (k: string, v: string) => (headers[k] = v) } as never as { headers: Record<string, string>; setHeader: () => void };
  };
  return { controller, state, streams, req, res };
}

describe('PublicFollowController', () => {
  it('returns the state with Cache-Control: no-store (also set before a 404 is thrown)', async () => {
    const { controller, state, req, res } = setup();
    const ok = res();
    await expect(controller.getState(TOKEN, req('1.1.1.1'), ok as never)).resolves.toEqual({ stintCount: 0 });
    expect(ok.headers['Cache-Control']).toBe('no-store');

    state.getState.mockRejectedValueOnce(new NotFoundException('Not found'));
    const miss = res();
    await expect(controller.getState(TOKEN, req('1.1.1.1'), miss as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(miss.headers['Cache-Control']).toBe('no-store');
  });

  it('rate limits GET per client IP: 429 with Retry-After once over the limit, other IPs unaffected', async () => {
    const { controller, state, req, res } = setup();
    for (let i = 0; i < FOLLOW_STATE_LIMIT_PER_MINUTE; i++) {
      await controller.getState(TOKEN, req('2.2.2.2'), res() as never);
    }
    const blocked = res();
    const error = await controller.getState(TOKEN, req('2.2.2.2'), blocked as never).catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
    expect(state.getState).toHaveBeenCalledTimes(FOLLOW_STATE_LIMIT_PER_MINUTE); // blocked call never hit the DB

    await expect(controller.getState(TOKEN, req('3.3.3.3'), res() as never)).resolves.toBeDefined();
  });

  it('keys on X-Forwarded-For only when FOLLOW_TRUST_PROXY=true', async () => {
    const { controller, req, res } = setup();
    const previous = process.env.FOLLOW_TRUST_PROXY;
    try {
      process.env.FOLLOW_TRUST_PROXY = 'true';
      for (let i = 0; i < FOLLOW_STATE_LIMIT_PER_MINUTE; i++) {
        await controller.getState(TOKEN, req('127.0.0.1', `x, 9.9.9.9`), res() as never);
      }
      await expect(controller.getState(TOKEN, req('127.0.0.1', 'x, 9.9.9.9'), res() as never)).rejects.toBeInstanceOf(HttpException);
      // a different real client behind the same proxy is not affected
      await expect(controller.getState(TOKEN, req('127.0.0.1', 'x, 8.8.8.8'), res() as never)).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.FOLLOW_TRUST_PROXY;
      else process.env.FOLLOW_TRUST_PROXY = previous;
    }
  });

  it('stream: resolves the token (404 passes through) then opens a capped stream', async () => {
    const { controller, state, streams, req } = setup();
    await expect(controller.stream(TOKEN, req('4.4.4.4'))).resolves.toBe('observable');
    expect(streams.open).toHaveBeenCalledWith(TOKEN, { teamId: 't1', eventId: 'e1' });

    state.resolveTarget.mockRejectedValueOnce(new NotFoundException('Not found'));
    await expect(controller.stream(TOKEN, req('4.4.4.4'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stream: a 429 from the per-token cap propagates before any SSE headers', async () => {
    const { controller, streams, req } = setup();
    streams.open.mockImplementation(() => {
      throw new HttpException('Too many open connections', 429);
    });
    await expect(controller.stream(TOKEN, req('5.5.5.5'))).rejects.toMatchObject({ status: 429 });
  });

  it('stream connects are rate limited per IP separately from state reads', async () => {
    const { controller, state, req, res } = setup();
    for (let i = 0; i < FOLLOW_STREAM_CONNECT_LIMIT_PER_MINUTE; i++) await controller.stream(TOKEN, req('6.6.6.6'));
    await expect(controller.stream(TOKEN, req('6.6.6.6'))).rejects.toMatchObject({ status: 429 });
    expect(state.resolveTarget).toHaveBeenCalledTimes(FOLLOW_STREAM_CONNECT_LIMIT_PER_MINUTE);
    await expect(controller.getState(TOKEN, req('6.6.6.6'), res() as never)).resolves.toBeDefined();
  });
});
