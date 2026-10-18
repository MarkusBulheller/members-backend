import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultFilter = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock('compression', () => ({ default: { filter: defaultFilter } }));

import { shouldCompress } from './compression-filter.js';

function makeReq(url: string, accept?: string) {
  return { originalUrl: url, url, headers: accept ? { accept } : {} } as never;
}
function makeRes(contentType?: string) {
  return { getHeader: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : undefined) } as never;
}

const SSE_URL = '/events/5f2c0f0e-1111-4222-8333-444455556666/teams/aaaa0f0e-1111-4222-8333-444455556666/stream';

describe('shouldCompress', () => {
  beforeEach(() => {
    defaultFilter.mockClear();
    defaultFilter.mockReturnValue(true);
  });

  it('skips responses whose content type is text/event-stream', () => {
    expect(shouldCompress(makeReq('/anything'), makeRes('text/event-stream; charset=utf-8'))).toBe(false);
    expect(defaultFilter).not.toHaveBeenCalled();
  });

  it('skips the team-plan SSE route even before a content type is set', () => {
    expect(shouldCompress(makeReq(SSE_URL), makeRes())).toBe(false);
    expect(shouldCompress(makeReq(`${SSE_URL}?x=1`), makeRes())).toBe(false);
    expect(shouldCompress(makeReq(`${SSE_URL}/`), makeRes())).toBe(false);
  });

  it('skips requests that ask for an event stream', () => {
    expect(shouldCompress(makeReq('/other', 'text/event-stream'), makeRes('application/json'))).toBe(false);
  });

  it('delegates ordinary JSON responses to the default compression filter', () => {
    expect(shouldCompress(makeReq('/drivers'), makeRes('application/json; charset=utf-8'))).toBe(true);
    expect(defaultFilter).toHaveBeenCalledTimes(1);
    defaultFilter.mockReturnValue(false);
    expect(shouldCompress(makeReq('/uploads/a.png'), makeRes('image/png'))).toBe(false);
  });

  it('does not treat sibling routes under teams as the stream', () => {
    expect(shouldCompress(makeReq('/events/e1/teams/t1/stints'), makeRes('application/json'))).toBe(true);
  });
});
