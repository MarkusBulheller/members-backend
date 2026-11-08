import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsService } from './events.service.js';

/** Builds an EventsService with just the collaborators the announcement-refresh path touches;
 * everything else is an inert stub. */
function makeService() {
  const eventsRepository = {
    findOne: vi.fn().mockResolvedValue({
      id: 'ev1',
      discordMessageId: 'msg-1',
      discordChannelId: 'chan-1',
      track: {},
      timeslots: [],
    }),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const signupsRepository = {
    find: vi.fn().mockResolvedValue([
      { userId: 'u1', carClass: 'GT3' },
      { userId: 'u2', carClass: null },
    ]),
    save: vi.fn().mockImplementation(async (s) => s),
  };
  const driverProfilesRepository = {
    find: vi.fn().mockResolvedValue([
      { userId: 'u1', displayName: 'Markus', iracingName: 'Markus Bulheller' },
      { userId: 'u2', displayName: 'Delta', iracingName: null },
    ]),
  };
  const discord = {
    postEventAnnouncement: vi.fn(),
    updateEventAnnouncement: vi.fn().mockResolvedValue('ok'),
  };
  const stub = {} as never;
  const service = new EventsService(
    eventsRepository as never,
    signupsRepository as never,
    stub,
    stub,
    stub,
    stub,
    driverProfilesRepository as never,
    discord as never,
  );
  return { service, eventsRepository, signupsRepository, discord };
}

describe('Discord announcement refresh on signup changes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('edits the existing message with display names, once, after a burst of changes', async () => {
    const { service, discord } = makeService();

    // Three quick changes (e.g. an admin toggling hours) -> a single edit once things settle.
    await service['saveSignup']({ eventId: 'ev1' } as never);
    await service['saveSignup']({ eventId: 'ev1' } as never);
    await service['saveSignup']({ eventId: 'ev1' } as never);
    expect(discord.updateEventAnnouncement).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(discord.updateEventAnnouncement).toHaveBeenCalledTimes(1);
    const [, ref, signups] = discord.updateEventAnnouncement.mock.calls[0];
    expect(ref).toEqual({ channelId: 'chan-1', messageId: 'msg-1' });
    expect(signups).toEqual([
      { name: 'Markus Bulheller', carClass: 'GT3' },
      { name: 'Delta', carClass: null },
    ]);
  });

  it('skips events that were never announced', async () => {
    const { service, eventsRepository, discord } = makeService();
    eventsRepository.findOne.mockResolvedValue({ id: 'ev1', discordMessageId: null, discordChannelId: null });

    service['scheduleAnnouncementRefresh']('ev1');
    await vi.advanceTimersByTimeAsync(3000);

    expect(discord.updateEventAnnouncement).not.toHaveBeenCalled();
  });

  it('forgets the message when Discord says it was deleted', async () => {
    const { service, eventsRepository, discord } = makeService();
    discord.updateEventAnnouncement.mockResolvedValue('gone');

    service['scheduleAnnouncementRefresh']('ev1');
    await vi.advanceTimersByTimeAsync(3000);

    expect(eventsRepository.update).toHaveBeenCalledWith('ev1', { discordChannelId: null, discordMessageId: null });
  });

  it('stores where a fresh announcement landed', async () => {
    const { service, eventsRepository, discord } = makeService();
    discord.postEventAnnouncement.mockResolvedValue({ channelId: 'c-new', messageId: 'm-new' });

    await service['announceEvent']({ id: 'ev1' } as never);

    expect(eventsRepository.update).toHaveBeenCalledWith('ev1', { discordChannelId: 'c-new', discordMessageId: 'm-new' });
  });

  it('puts a weekly series sign-up pinned in its own event channel, created when it is published', async () => {
    const { service, eventsRepository, discord } = makeService();
    const channelIdForAnnouncement = vi.fn().mockResolvedValue('own-chan');
    (service as unknown as { moduleRef: unknown }).moduleRef = { get: () => ({ channelIdForAnnouncement }) };
    discord.postEventAnnouncement.mockResolvedValue({ channelId: 'own-chan', messageId: 'm-pinned' });

    await service['announceEvent']({ id: 'ev2', kind: 'WEEKLY' } as never);

    expect(channelIdForAnnouncement).toHaveBeenCalledWith('ev2');
    expect(discord.postEventAnnouncement).toHaveBeenCalledTimes(1);
    expect(discord.postEventAnnouncement.mock.calls[0][2]).toEqual({ channelId: 'own-chan', pin: true });
    expect(eventsRepository.update).toHaveBeenCalledWith('ev2', { discordChannelId: 'own-chan', discordMessageId: 'm-pinned' });
  });

  it('posts nothing for a weekly event whose channel could not be made, and never uses the events channel', async () => {
    const { service, eventsRepository, discord } = makeService();
    (service as unknown as { moduleRef: unknown }).moduleRef = {
      get: () => ({ channelIdForAnnouncement: vi.fn().mockResolvedValue(null) }),
    };

    await service['announceEvent']({ id: 'ev2', kind: 'WEEKLY' } as never);

    expect(discord.postEventAnnouncement).not.toHaveBeenCalled();
    expect(eventsRepository.update).not.toHaveBeenCalled();
  });

  it('keeps posting a special event in the events channel, unpinned and without making a channel', async () => {
    const { service, eventsRepository, discord } = makeService();
    const channelIdForAnnouncement = vi.fn();
    (service as unknown as { moduleRef: unknown }).moduleRef = { get: () => ({ channelIdForAnnouncement }) };
    discord.postEventAnnouncement.mockResolvedValue({ channelId: 'events-chan', messageId: 'm' });

    await service['announceEvent']({ id: 'ev3', kind: 'SPECIAL' } as never);

    expect(channelIdForAnnouncement).not.toHaveBeenCalled();
    expect(discord.postEventAnnouncement.mock.calls[0]).toHaveLength(2);
    expect(eventsRepository.update).toHaveBeenCalledWith('ev3', { discordChannelId: 'events-chan', discordMessageId: 'm' });
  });
});
