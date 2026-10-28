import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordBotService } from './discord-bot.service.js';

afterEach(() => vi.unstubAllGlobals());

function makeService(creds: { token: string | null; channelId: string | null } = { token: 'tok', channelId: 'chan' }) {
  const config = { get: (_key: string, fallback?: string) => fallback };
  const settings = { getCredentialsForPosting: vi.fn().mockResolvedValue(creds) };
  return new DiscordBotService(config as never, {} as never, settings as never);
}

const ok = (body: unknown = {}, status = 200) => ({
  ok: true,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const fail = (status: number, text = 'nope') => ({ ok: false, status, json: async () => ({}), text: async () => text });

describe('DiscordBotService.createTeamThread', () => {
  it('posts the starter in the parent channel, then opens a public 7-day thread from that message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ id: 'm1' }))
      .mockResolvedValueOnce(ok({ id: 'th1', guild_id: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().createTeamThread({
      parentChannelId: 'chan',
      name: 'Spa 6h · W2W #1',
      starterContent: 'hello <@111>',
      mentionUserIds: ['111'],
    });

    expect(result).toEqual({ threadId: 'th1', starterMessageId: 'm1' });
    const [msgUrl, msgInit] = fetchMock.mock.calls[0];
    expect(msgUrl).toBe('https://discord.com/api/v10/channels/chan/messages');
    expect(msgInit.method).toBe('POST');
    expect(msgInit.headers.Authorization).toBe('Bot tok');
    expect(JSON.parse(msgInit.body)).toEqual({
      content: 'hello <@111>',
      flags: 4,
      allowed_mentions: { parse: [], users: ['111'] },
    });
    const [threadUrl, threadInit] = fetchMock.mock.calls[1];
    expect(threadUrl).toBe('https://discord.com/api/v10/channels/chan/messages/m1/threads');
    expect(JSON.parse(threadInit.body)).toEqual({ name: 'Spa 6h · W2W #1', auto_archive_duration: 10080 });
  });

  it('never allows @everyone or role pings: only the listed users', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: 'm1' })).mockResolvedValueOnce(ok({ id: 'th1' }));
    vi.stubGlobal('fetch', fetchMock);
    await makeService().createTeamThread({ parentChannelId: 'chan', name: 'x', starterContent: '@everyone' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it('caps the thread name at 100 characters', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: 'm1' })).mockResolvedValueOnce(ok({ id: 'th1' }));
    vi.stubGlobal('fetch', fetchMock);
    await makeService().createTeamThread({ parentChannelId: 'chan', name: 'x'.repeat(300), starterContent: 'c' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).name).toHaveLength(100);
  });

  it('throws a clear error without a token and posts nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeService({ token: null, channelId: 'chan' }).createTeamThread({ parentChannelId: 'chan', name: 'n', starterContent: 'c' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes the orphan starter message when the thread cannot be created', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ id: 'm1' }))
      .mockResolvedValueOnce(fail(403, 'Missing Permissions'))
      .mockResolvedValueOnce(ok({}, 204));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeService().createTeamThread({ parentChannelId: 'chan', name: 'n', starterContent: 'c' }),
    ).rejects.toThrow(/Create Public Threads/);
    expect(fetchMock.mock.calls[2][0]).toBe('https://discord.com/api/v10/channels/chan/messages/m1');
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });

  it('maps a network failure to a 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(
      makeService().createTeamThread({ parentChannelId: 'chan', name: 'n', starterContent: 'c' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('DiscordBotService.getEventsChannelId', () => {
  it('returns the configured channel or says to set it', async () => {
    expect(await makeService().getEventsChannelId()).toBe('chan');
    await expect(makeService({ token: 'tok', channelId: null }).getEventsChannelId()).rejects.toThrow(
      'Set the events channel first',
    );
  });
});

describe('DiscordBotService thread members', () => {
  it('addThreadMember PUTs the user and reports success/failure without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({}, 204)).mockResolvedValueOnce(fail(403));
    vi.stubGlobal('fetch', fetchMock);
    const service = makeService();
    expect(await service.addThreadMember('th1', '111')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/th1/thread-members/111');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(await service.addThreadMember('th1', '222')).toBe(false);
  });

  it('addThreadMembers swallows per-user failures and returns counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok({}, 204))
        .mockResolvedValueOnce(fail(404))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(ok({}, 204)),
    );
    expect(await makeService().addThreadMembers('th1', ['1', '2', '3', '4'])).toEqual({ added: 2, failed: 2 });
  });

  it('addThreadMembers reports everyone failed when there is no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await makeService({ token: null, channelId: null }).addThreadMembers('th1', ['1', '2'])).toEqual({
      added: 0,
      failed: 2,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DiscordBotService.postThreadMessage', () => {
  it('posts content into the thread with only the given users pingable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: 'msg9' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await makeService().postThreadMessage('th1', 'plan', ['5'])).toBe('msg9');
    expect(fetchMock.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/th1/messages');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      content: 'plan',
      allowed_mentions: { parse: [], users: ['5'] },
    });
  });

  it('retries once after a 429 using retry_after', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ retry_after: 0 }), text: async () => '' })
      .mockResolvedValueOnce(ok({ id: 'msg9' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await makeService().postThreadMessage('th1', 'x')).toBe('msg9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when Discord refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(403)));
    await expect(makeService().postThreadMessage('th1', 'x')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('DiscordBotService.findThreadExists', () => {
  it('is true for 200, false for 404, and throws for anything else (never "deleted" by accident)', async () => {
    const service = makeService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ id: 'th1' })));
    expect(await service.findThreadExists('th1')).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(404)));
    expect(await service.findThreadExists('th1')).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(500)));
    await expect(service.findThreadExists('th1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('DiscordBotService.getGuildIdForChannel', () => {
  it('fetches the guild id once and caches it; null when unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: 'chan', guild_id: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = makeService();
    expect(await service.getGuildIdForChannel('chan')).toBe('g1');
    expect(await service.getGuildIdForChannel('chan')).toBe('g1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(403)));
    expect(await makeService().getGuildIdForChannel('other')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('x')));
    expect(await makeService().getGuildIdForChannel('other')).toBeNull();
  });
});
