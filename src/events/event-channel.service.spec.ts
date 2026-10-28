import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../common/enums/sim.enum.js';
import { DiscordBotService } from '../discord-bot/discord-bot.service.js';
import {
  buildEventChannelName,
  buildEventChannelTopic,
  buildEventStarterMessage,
  EventChannelService,
} from './event-channel.service.js';

const START = Date.parse('2026-11-14T16:00:00Z');

describe('buildEventChannelName', () => {
  it('makes a lowercase, dashed, ASCII channel name', () => {
    expect(buildEventChannelName('Le Mans 24h')).toBe('le-mans-24h');
    expect(buildEventChannelName('  IMSA @ Daytona!! (Round 3) ')).toBe('imsa-daytona-round-3');
    expect(buildEventChannelName('Nürburgring Langstrecke')).toBe('nurburgring-langstrecke');
    expect(buildEventChannelName('Spa_6h')).toBe('spa_6h');
  });

  it('falls back to "event" and caps the length', () => {
    expect(buildEventChannelName('###')).toBe('event');
    expect(buildEventChannelName('日本')).toBe('event');
    const long = buildEventChannelName('a'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('buildEventStarterMessage / topic', () => {
  const base = {
    title: 'Le Mans 24h',
    sim: Sim.IRACING,
    trackName: 'Sarthe',
    carClasses: ['GT3'],
    raceLengthMinutes: 1440,
    startTimesMs: [START],
    signupDeadlineMs: null,
    signedUpCount: 4,
    eventUrl: 'https://portal.test/events/e1',
  };

  it('lists the essentials with Discord timestamps and never pings anyone', () => {
    const text = buildEventStarterMessage(base);
    expect(text).toContain('🏁 **Le Mans 24h** · iRacing');
    expect(text).toContain('**Race length:** 24h');
    expect(text).toContain(`**Start:** <t:${START / 1000}:F>`);
    expect(text).toContain('**Signed up:** 4');
    expect(text).toContain('**Event page:** https://portal.test/events/e1');
    expect(text).not.toContain('<@');
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('shows several sorted start times with a "more" note, the deadline, LMU, and escapes markdown', () => {
    const many = Array.from({ length: 8 }, (_, i) => START + (7 - i) * 3_600_000);
    const text = buildEventStarterMessage({
      ...base,
      sim: Sim.LMU,
      title: '*Big* race',
      startTimesMs: many,
      signupDeadlineMs: START - 3_600_000,
    });
    expect(text).toContain('Le Mans Ultimate');
    expect(text).toContain('\\*Big\\* race');
    expect(text).toContain('**Start times:**');
    expect(text).toContain('…and 2 more');
    expect(text).toContain('**Sign up by:**');
  });

  it('builds a one-line topic within Discord\'s limit', () => {
    expect(buildEventChannelTopic('Sarthe', 1440, 'https://portal.test/events/e1')).toBe(
      'Sarthe · 24h · https://portal.test/events/e1',
    );
    expect(buildEventChannelTopic('x'.repeat(2000), 60, 'u').length).toBeLessThanOrEqual(1024);
  });
});

function setup(eventOverride: Record<string, unknown> | null | undefined = undefined) {
  const event =
    eventOverride === undefined
      ? {
          id: 'e1',
          title: 'Le Mans 24h',
          sim: Sim.IRACING,
          track: { name: 'Sarthe' },
          carClasses: ['GT3'],
          raceLengthMinutes: 1440,
          startsAt: new Date(START),
          signupDeadline: null,
          timeslots: [{ startsAt: new Date(START) }],
          discordEventChannelId: null,
        }
      : eventOverride;
  const eventsRepository = { findOne: vi.fn().mockResolvedValue(event), update: vi.fn().mockResolvedValue(undefined) };
  const signupsRepository = { count: vi.fn().mockResolvedValue(6) };
  const discordBot = {
    findThreadExists: vi.fn().mockResolvedValue(true),
    getGuildIdForChannel: vi.fn().mockResolvedValue('guild1'),
    getEventCategoryId: vi.fn().mockResolvedValue('cat1'),
    createEventChannel: vi.fn().mockResolvedValue({ channelId: 'ch1', guildId: 'guild1' }),
  };
  const config = { get: vi.fn().mockReturnValue('https://portal.test/') };
  const service = new EventChannelService(
    eventsRepository as never,
    signupsRepository as never,
    discordBot as never,
    config as never,
  );
  return { service, eventsRepository, signupsRepository, discordBot };
}

describe('EventChannelService.getStatus', () => {
  it('reports no channel when none is stored', async () => {
    const { service, discordBot } = setup();
    expect(await service.getStatus('e1')).toEqual({ exists: false, channelId: null, url: null });
    expect(discordBot.findThreadExists).not.toHaveBeenCalled();
  });

  it('reports a live channel with its Discord link, a deleted one as absent, an unverifiable one as existing', async () => {
    const live = setup({ id: 'e1', discordEventChannelId: 'ch9' });
    expect(await live.service.getStatus('e1')).toEqual({
      exists: true,
      channelId: 'ch9',
      url: 'https://discord.com/channels/guild1/ch9',
    });

    const gone = setup({ id: 'e1', discordEventChannelId: 'ch9' });
    gone.discordBot.findThreadExists.mockResolvedValue(false);
    expect((await gone.service.getStatus('e1')).exists).toBe(false);

    const hiccup = setup({ id: 'e1', discordEventChannelId: 'ch9' });
    hiccup.discordBot.findThreadExists.mockRejectedValue(new Error('502'));
    expect((await hiccup.service.getStatus('e1')).exists).toBe(true);
  });

  it('404s for an unknown event', async () => {
    await expect(setup(null).service.getStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EventChannelService.ensureChannel', () => {
  it('creates the channel in the event category and stores its id', async () => {
    const { service, discordBot, eventsRepository } = setup();

    const result = await service.ensureChannel('e1', 'admin1');

    expect(result).toEqual({ created: true, channelId: 'ch1', url: 'https://discord.com/channels/guild1/ch1' });
    const call = discordBot.createEventChannel.mock.calls[0][0] as {
      categoryId: string;
      name: string;
      topic: string;
      starterContent: string;
    };
    expect(call.categoryId).toBe('cat1');
    expect(call.name).toBe('le-mans-24h');
    expect(call.topic).toContain('Sarthe');
    expect(call.starterContent).toContain('**Signed up:** 6');
    expect(call.starterContent).toContain('https://portal.test/events/e1');
    expect(eventsRepository.update).toHaveBeenCalledWith({ id: 'e1' }, { discordEventChannelId: 'ch1' });
  });

  it('returns an existing live channel untouched', async () => {
    const { service, discordBot } = setup({ id: 'e1', discordEventChannelId: 'ch9' });
    const result = await service.ensureChannel('e1', 'admin1');
    expect(result).toEqual({ created: false, channelId: 'ch9', url: 'https://discord.com/channels/guild1/ch9' });
    expect(discordBot.createEventChannel).not.toHaveBeenCalled();
  });

  it('creates a new channel when the stored one was deleted in Discord', async () => {
    const { service, discordBot } = setup({
      id: 'e1', title: 'T', sim: Sim.IRACING, track: { name: 'X' }, carClasses: [], raceLengthMinutes: 60,
      startsAt: new Date(START), timeslots: [], discordEventChannelId: 'old',
    });
    discordBot.findThreadExists.mockResolvedValue(false);
    expect((await service.ensureChannel('e1', 'admin1')).created).toBe(true);
  });

  it('collapses a double click into one channel', async () => {
    const { service, discordBot } = setup();
    const [a, b] = await Promise.all([service.ensureChannel('e1', 'admin1'), service.ensureChannel('e1', 'admin1')]);
    expect(a).toEqual(b);
    expect(discordBot.createEventChannel).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the category is not configured or Discord refuses', async () => {
    const noCategory = setup();
    noCategory.discordBot.getEventCategoryId.mockRejectedValue(new BadRequestException('Set the event category first'));
    await expect(noCategory.service.ensureChannel('e1', 'admin1')).rejects.toThrow('Set the event category first');
    expect(noCategory.eventsRepository.update).not.toHaveBeenCalled();

    const refused = setup();
    refused.discordBot.createEventChannel.mockRejectedValue(new Error('Discord refused'));
    await expect(refused.service.ensureChannel('e1', 'admin1')).rejects.toThrow('Discord refused');
    expect(refused.eventsRepository.update).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('DiscordBotService.createEventChannel', () => {
  function makeBot() {
    const config = { get: (_key: string, fallback?: string) => fallback };
    const settings = {
      getCredentialsForPosting: vi.fn().mockResolvedValue({ token: 'tok', channelId: 'chan' }),
      getEventChannelCredentials: vi.fn().mockResolvedValue({ token: 'tok', categoryId: 'cat1' }),
    };
    return new DiscordBotService(config as never, {} as never, settings as never);
  }
  const ok = (body: unknown = {}, status = 200) => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fail = (status: number, text = 'nope') => ({ ok: false, status, json: async () => ({}), text: async () => text });

  it('looks up the category, creates a text channel under it and posts the first message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ type: 4, guild_id: 'g1' }))
      .mockResolvedValueOnce(ok({ id: 'c9' }))
      .mockResolvedValueOnce(ok({ id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeBot().createEventChannel({
      categoryId: 'cat1',
      name: 'le-mans-24h',
      topic: 'Sarthe',
      starterContent: 'hello',
    });

    expect(result).toEqual({ channelId: 'c9', guildId: 'g1' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/cat1');
    const [createUrl, createInit] = fetchMock.mock.calls[1];
    expect(createUrl).toBe('https://discord.com/api/v10/guilds/g1/channels');
    expect(JSON.parse(createInit.body)).toEqual({ name: 'le-mans-24h', type: 0, parent_id: 'cat1', topic: 'Sarthe' });
    const [msgUrl, msgInit] = fetchMock.mock.calls[2];
    expect(msgUrl).toBe('https://discord.com/api/v10/channels/c9/messages');
    expect(JSON.parse(msgInit.body)).toMatchObject({ content: 'hello', allowed_mentions: { parse: [] } });
  });

  it('rejects an id that is not a category, and a missing category', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ type: 0, guild_id: 'g1' })));
    await expect(
      makeBot().createEventChannel({ categoryId: 'x', name: 'n', starterContent: 's' }),
    ).rejects.toThrow('not a category');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fail(404)));
    await expect(
      makeBot().createEventChannel({ categoryId: 'x', name: 'n', starterContent: 's' }),
    ).rejects.toThrow('not found');
  });

  it('explains a 403 with the permissions the bot needs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(ok({ type: 4, guild_id: 'g1' })).mockResolvedValueOnce(fail(403)),
    );
    await expect(
      makeBot().createEventChannel({ categoryId: 'cat1', name: 'n', starterContent: 's' }),
    ).rejects.toThrow('Manage Channels');
  });

  it('keeps the channel when only the first message fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok({ type: 4, guild_id: 'g1' }))
        .mockResolvedValueOnce(ok({ id: 'c9' }))
        .mockResolvedValueOnce(fail(500)),
    );
    expect(
      await makeBot().createEventChannel({ categoryId: 'cat1', name: 'n', starterContent: 's' }),
    ).toEqual({ channelId: 'c9', guildId: 'g1' });
  });

  it('getEventCategoryId throws a clear 400 when unset', async () => {
    const bot = makeBot();
    (bot as unknown as { discordBotSettingsService: { getEventChannelCredentials: () => Promise<unknown> } }).discordBotSettingsService.getEventChannelCredentials = async () => ({ token: 'tok', categoryId: null });
    await expect(bot.getEventCategoryId()).rejects.toBeInstanceOf(BadRequestException);
  });
});
