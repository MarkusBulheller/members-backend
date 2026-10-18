import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordBotService } from './discord-bot.service.js';
import type { Event } from '../events/event.entity.js';

function makeService(creds = { token: 'tok', channelId: 'chan-new' }) {
  const config = { get: (_key: string, fallback?: string) => fallback };
  const iracingSeries = { getRaceWeekWeatherSummary: vi.fn() };
  const settings = { getCredentialsForPosting: vi.fn().mockResolvedValue(creds) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DiscordBotService(config as any, iracingSeries as any, settings as any);
}

const event = {
  id: 'ev1',
  title: 'GES Le Mans 24h',
  description: null,
  sim: 'IRACING',
  raceLengthMinutes: 1440,
  carClasses: ['GT3'],
  startsAt: new Date('2026-10-24T13:30:00Z'),
  timeslots: [{ startsAt: new Date('2026-10-24T13:30:00Z') }],
  track: { name: 'Circuit de la Sarthe', imageUrl: null },
  iracingSeasonId: null,
  iracingRaceWeekNum: null,
} as unknown as Event;

const ref = { channelId: 'chan-old', messageId: 'msg-1' };

function textOf(body: { components: { components: { content?: string }[] }[] }): string {
  return body.components[0].components.map((c) => c.content ?? '').join('\n');
}

afterEach(() => vi.unstubAllGlobals());

describe('DiscordBotService announcement', () => {
  it('lists signups with class, in order, with a count', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'm', channel_id: 'c' }) });
    vi.stubGlobal('fetch', fetchMock);

    await makeService().postEventAnnouncement(event, [
      { name: 'Markus Bulheller', carClass: 'GT3' },
      { name: 'Delta', carClass: null },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const text = textOf(body);
    expect(text).toContain('**Signed up (2):**\n• Markus Bulheller — GT3\n• Delta');
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('shows a friendly empty state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'm' }) });
    vi.stubGlobal('fetch', fetchMock);

    await makeService().postEventAnnouncement(event, []);

    expect(textOf(JSON.parse(fetchMock.mock.calls[0][1].body))).toContain('**Signed up (0):**\nNo one yet');
  });

  it('escapes markdown in names and caps a long list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'm' }) });
    vi.stubGlobal('fetch', fetchMock);

    const many = Array.from({ length: 33 }, (_, i) => ({ name: i === 0 ? 'a_b*c' : `Driver ${i}`, carClass: null }));
    await makeService().postEventAnnouncement(event, many);

    const text = textOf(JSON.parse(fetchMock.mock.calls[0][1].body));
    expect(text).toContain('**Signed up (33):**');
    expect(text).toContain('• a\\_b\\*c');
    expect(text).toContain('…and 3 more');
    expect(text).not.toContain('Driver 32');
  });

  it('returns where the message landed so it can be edited later', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'm9', channel_id: 'c9' }) }));
    expect(await makeService().postEventAnnouncement(event, [])).toEqual({ channelId: 'c9', messageId: 'm9' });
  });

  it('edits the original message in its original channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().updateEventAnnouncement(event, ref, [{ name: 'Delta', carClass: 'GT3' }]);

    expect(result).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/chan-old/messages/msg-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body).flags).toBe(1 << 15);
    expect(textOf(JSON.parse(init.body))).toContain('• Delta — GT3');
  });

  it("reports 'gone' when the message was deleted, 'failed' on other errors, and never throws", async () => {
    const service = makeService();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));
    expect(await service.updateEventAnnouncement(event, ref, [])).toBe('gone');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    expect(await service.updateEventAnnouncement(event, ref, [])).toBe('failed');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await service.updateEventAnnouncement(event, ref, [])).toBe('failed');
  });

  it('does nothing without a bot token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = makeService({ token: '', channelId: '' });

    expect(await service.updateEventAnnouncement(event, ref, [])).toBe('failed');
    expect(await service.postEventAnnouncement(event, [])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
