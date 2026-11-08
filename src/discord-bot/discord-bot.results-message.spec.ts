import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordBotService } from './discord-bot.service.js';

afterEach(() => vi.unstubAllGlobals());

function makeService(creds: { token: string | null; channelId: string | null }) {
  const config = { get: (_key: string, fallback?: string) => fallback };
  const settings = { getResultsPostingCredentials: vi.fn().mockResolvedValue(creds) };
  return new DiscordBotService(config as never, {} as never, settings as never);
}

describe('DiscordBotService.postResultsMessage', () => {
  it('posts plain content to the results channel with mentions disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await makeService({ token: 'tok', channelId: '555' }).postResultsMessage('hello @everyone');

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/555/messages');
    expect(init.headers.Authorization).toBe('Bot tok');
    expect(JSON.parse(init.body)).toEqual({ content: 'hello @everyone', allowed_mentions: { parse: [] } });
  });

  it('posts the embed instead of the text when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await makeService({ token: 'tok', channelId: '555' }).postResultsMessage('fallback text', { title: 'T', color: 1 });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ embeds: [{ title: 'T', color: 1 }], allowed_mentions: { parse: [] } });
  });

  it('falls back to the plain text when Discord refuses the embed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Invalid Form Body' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await makeService({ token: 'tok', channelId: '555' }).postResultsMessage('fallback text', { title: 'T' });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ content: 'fallback text', allowed_mentions: { parse: [] } });
  });

  it('posts nothing when the token or results channel is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await makeService({ token: 'tok', channelId: null }).postResultsMessage('x')).toBe(false);
    expect(await makeService({ token: null, channelId: '555' }).postResultsMessage('x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false instead of throwing when Discord refuses or the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'Missing Access' }));
    expect(await makeService({ token: 'tok', channelId: '555' }).postResultsMessage('x')).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await makeService({ token: 'tok', channelId: '555' }).postResultsMessage('x')).toBe(false);
  });
});
