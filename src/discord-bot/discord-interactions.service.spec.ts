import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { DiscordInteractionsService, formatSlotLabel } from './discord-interactions.service.js';
import type { DiscordInteraction } from './discord-interactions.types.js';
import { parseCustomId } from './discord-interactions.types.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const S3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const CLICKER = '300000000000000001';
const ALERT = '400000000000000002';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: 'GES Le Mans 24h',
    status: EventStatus.PUBLISHED,
    signupDeadline: null,
    carClasses: ['GT3', 'LMP2'],
    discordMessageId: 'msg-1',
    // Deliberately unsorted: the form must list them chronologically.
    timeslots: [
      { id: S3, startsAt: new Date('2026-10-25T09:00:00Z') },
      { id: S1, startsAt: new Date('2026-10-24T13:00:00Z') },
      { id: S2, startsAt: new Date('2026-10-24T20:00:00Z') },
    ],
    ...overrides,
  };
}

const memberUser = { id: 'user-1', discordId: CLICKER, status: UserStatus.APPROVED };
const guestProfile = { id: 'profile-g', userId: null, discordId: CLICKER };

function click(customId: string, values?: string[], user: { id: string; username?: string; bot?: boolean } = { id: CLICKER, username: 'clicker' }): DiscordInteraction {
  return { type: 3, application_id: 'app', token: 'tok', member: { user }, data: { custom_id: customId, component_type: 2, values } };
}

function makeService(opts: { event?: unknown; user?: unknown; profile?: unknown; signup?: unknown; guestSignup?: unknown; alertUserId?: string | null } = {}) {
  const eventsRepository = { findOne: vi.fn().mockResolvedValue('event' in opts ? opts.event : makeEvent()) };
  const usersRepository = { findOne: vi.fn().mockResolvedValue(opts.user ?? null) };
  const driversService = { findGuestByDiscordIdentity: vi.fn().mockResolvedValue(opts.profile ?? null) };
  const signupsRepository = { findOne: vi.fn().mockResolvedValue(opts.signup ?? null) };
  const eventsService = {
    signup: vi.fn().mockResolvedValue({}),
    cancelSignup: vi.fn().mockResolvedValue(undefined),
    scheduleAnnouncementRefreshFor: vi.fn(),
  };
  const guestSignupsService = {
    upsert: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    findByEventAndProfile: vi.fn().mockResolvedValue(opts.guestSignup ?? null),
  };
  const settingsService = {
    getInteractionConfig: vi.fn().mockResolvedValue({ publicKey: 'k', alertUserId: opts.alertUserId === undefined ? ALERT : opts.alertUserId }),
  };
  const discordBotService = { sendDirectMessage: vi.fn().mockResolvedValue(true) };
  const service = new DiscordInteractionsService(
    eventsRepository as never,
    usersRepository as never,
    driversService as never,
    signupsRepository as never,
    eventsService as never,
    guestSignupsService as never,
    settingsService as never,
    discordBotService as never,
  );
  return { service, eventsRepository, usersRepository, driversService, signupsRepository, eventsService, guestSignupsService, discordBotService };
}

/** Flush fire-and-forget promises (the alert DM). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Row = { components: { custom_id: string; options?: { value: string; default: boolean }[]; disabled?: boolean; max_values?: number }[] };
const rows = (res: { data?: { components?: unknown[] } }) => (res.data?.components ?? []) as Row[];
const ids = (res: { data?: { components?: unknown[] } }) => rows(res).map((r) => r.components[0].custom_id.split(':')[0]);
const confirmButton = (res: { data?: { components?: unknown[] } }) => rows(res).at(-1)!.components[0];

describe('parseCustomId', () => {
  it('parses every known action', () => {
    for (const action of ['sg', 'wd', 'st', 'fc', 'cl', 'go', 'xx']) {
      expect(parseCustomId(`${action}:${EVENT_ID}`)).toEqual({ action, eventId: EVENT_ID });
    }
  });

  it('rejects anything else', () => {
    expect(parseCustomId(`zz:${EVENT_ID}`)).toBeNull();
    expect(parseCustomId('sg:not-a-uuid')).toBeNull();
    expect(parseCustomId(`sg:${EVENT_ID}:extra`)).toBeNull();
    expect(parseCustomId(`sg:${EVENT_ID}`.padEnd(120, 'a'))).toBeNull();
    expect(parseCustomId(undefined)).toBeNull();
    expect(parseCustomId(42)).toBeNull();
  });
});

describe('DiscordInteractionsService', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  describe('basics', () => {
    it('answers PING with PONG', async () => {
      const { service } = makeService();
      expect(await service.handle({ type: 1 })).toEqual({ type: 1 });
    });

    it('ignores interactions from bots and unparseable custom ids', async () => {
      const { service, eventsRepository } = makeService({ user: memberUser });
      const bot = await service.handle(click(`sg:${EVENT_ID}`, undefined, { id: CLICKER, bot: true }));
      expect(bot.data?.content).toMatch(/Bots can't sign up/);
      const junk = await service.handle(click('whatever'));
      expect(junk.data?.flags).toBe(64);
      expect(eventsRepository.findOne).not.toHaveBeenCalled();
    });

    it('formats start times in UTC', () => {
      expect(formatSlotLabel(new Date('2026-10-24T13:00:00Z'))).toBe('Sat 24 Oct · 13:00 UTC');
    });
  });

  describe('unlinked clickers', () => {
    it('replies ephemerally, names the alert user and DMs them once per 30 minutes', async () => {
      const { service, discordBotService } = makeService();
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.type).toBe(4);
      expect(res.data?.flags).toBe(64);
      expect(res.data?.content).toBe(
        `I couldn't find a driver profile linked to your Discord account (@clicker). Please contact <@${ALERT}> so they can link you.`,
      );
      await flush();
      expect(discordBotService.sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(discordBotService.sendDirectMessage).toHaveBeenCalledWith(
        ALERT,
        `<@${CLICKER}> (@clicker) tried to sign up for **GES Le Mans 24h** but is not linked to a driver profile. Add their Discord username to a guest driver, or ask them to log in to the portal.`,
      );

      await service.handle(click(`sg:${EVENT_ID}`));
      await flush();
      expect(discordBotService.sendDirectMessage).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31 * 60_000);
      await service.handle(click(`wd:${EVENT_ID}`));
      await flush();
      expect(discordBotService.sendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it('without an alert user, points at a team admin and sends no DM', async () => {
      const { service, discordBotService } = makeService({ alertUserId: null });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toBe(
        "I couldn't find a driver profile linked to your Discord account (@clicker). Please contact a team admin so they can link you.",
      );
      await flush();
      expect(discordBotService.sendDirectMessage).not.toHaveBeenCalled();
    });

    it('treats a non-approved user as unlinked (and does not fall through to a guest match)', async () => {
      const { service, driversService } = makeService({
        user: { ...memberUser, status: UserStatus.SUSPENDED },
        profile: guestProfile,
      });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toMatch(/couldn't find a driver profile/);
      expect(driversService.findGuestByDiscordIdentity).not.toHaveBeenCalled();
    });

    it('still replies when the alert DM throws or fails', async () => {
      const { service, discordBotService } = makeService();
      discordBotService.sendDirectMessage.mockRejectedValueOnce(new Error('boom'));
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toMatch(/Please contact/);
      await flush();
      // A failed DM doesn't start the 30-minute mute: the next click retries.
      discordBotService.sendDirectMessage.mockResolvedValueOnce(true);
      await service.handle(click(`sg:${EVENT_ID}`));
      await flush();
      expect(discordBotService.sendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it('looks guests up by Discord id plus the clicker username, members only by id', async () => {
      const { service, driversService, usersRepository } = makeService({ profile: guestProfile });
      await service.handle(click(`sg:${EVENT_ID}`));
      expect(usersRepository.findOne).toHaveBeenCalledWith({ where: { discordId: CLICKER } });
      expect(driversService.findGuestByDiscordIdentity).toHaveBeenCalledWith(CLICKER, 'clicker');
    });
  });

  describe('closed events', () => {
    it('refuses when the event is not published and asks for the post to be refreshed', async () => {
      const { service, eventsService } = makeService({ user: memberUser, event: makeEvent({ status: EventStatus.SIGNUPS_CLOSED }) });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toBe('Signups for this event are closed.');
      expect(res.data?.flags).toBe(64);
      expect(eventsService.scheduleAnnouncementRefreshFor).toHaveBeenCalledWith(EVENT_ID);
    });

    it('refuses once the signup deadline has passed', async () => {
      const { service } = makeService({ user: memberUser, event: makeEvent({ signupDeadline: new Date(Date.now() - 1000) }) });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toBe('Signups for this event are closed.');
    });

    it('answers for an event that does not exist', async () => {
      const { service } = makeService({ user: memberUser, event: null });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toBe('This event no longer exists.');
    });
  });

  describe('sign-up form', () => {
    it('opens an ephemeral form with chronological start times, a class menu and a disabled confirm', async () => {
      const { service } = makeService({ user: memberUser });
      const res = await service.handle(click(`sg:${EVENT_ID}`));

      expect(res.type).toBe(4);
      expect(res.data?.flags).toBe(64);
      expect(ids(res)).toEqual(['st', 'cl', 'go']);
      const st = rows(res)[0].components[0];
      expect(st.options?.map((o) => o.value)).toEqual([S1, S2, S3]);
      expect(st.max_values).toBe(3);
      expect(confirmButton(res).disabled).toBe(true);
      expect(rows(res).at(-1)!.components.map((c) => c.custom_id)).toEqual([`go:${EVENT_ID}`, `xx:${EVENT_ID}`]);
    });

    it('re-renders on each selection (type 7), adding the first-choice menu only for 2+ start times', async () => {
      const { service } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));

      const one = await service.handle(click(`st:${EVENT_ID}`, [S2]));
      expect(one.type).toBe(7);
      expect(ids(one)).toEqual(['st', 'cl', 'go']);
      expect(rows(one)[0].components[0].options?.filter((o) => o.default).map((o) => o.value)).toEqual([S2]);
      expect(confirmButton(one).disabled).toBe(true); // class still missing

      const two = await service.handle(click(`st:${EVENT_ID}`, [S3, S1]));
      expect(ids(two)).toEqual(['st', 'fc', 'cl', 'go']);
      const fc = rows(two)[1].components[0];
      expect(fc.options?.map((o) => o.value)).toEqual([S1, S3]);
      expect(fc.options?.find((o) => o.default)?.value).toBe(S1); // chronological first by default

      const picked = await service.handle(click(`fc:${EVENT_ID}`, [S3]));
      expect(rows(picked)[1].components[0].options?.find((o) => o.default)?.value).toBe(S3);

      const withClass = await service.handle(click(`cl:${EVENT_ID}`, ['LMP2']));
      expect(rows(withClass)[2].components[0].options?.find((o) => o.default)?.value).toBe('LMP2');
      expect(confirmButton(withClass).disabled).toBe(false);

      // Dropping the first choice from the start times resets it.
      const dropped = await service.handle(click(`st:${EVENT_ID}`, [S1, S2]));
      expect(rows(dropped)[1].components[0].options?.find((o) => o.default)?.value).toBe(S1);
    });

    it('ignores forged slot ids and class values', async () => {
      const { service } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));
      const res = await service.handle(click(`st:${EVENT_ID}`, ['not-a-slot', S1]));
      expect(rows(res)[0].components[0].options?.filter((o) => o.default).map((o) => o.value)).toEqual([S1]);
      const cl = await service.handle(click(`cl:${EVENT_ID}`, ['Hypercar']));
      expect(confirmButton(cl).disabled).toBe(true);
    });

    it('hides the class menu for a single-class event and needs no class to confirm', async () => {
      const { service } = makeService({ user: memberUser, event: makeEvent({ carClasses: ['GT3'] }) });
      await service.handle(click(`sg:${EVENT_ID}`));
      const res = await service.handle(click(`st:${EVENT_ID}`, [S1]));
      expect(ids(res)).toEqual(['st', 'go']);
      expect(confirmButton(res).disabled).toBe(false);
    });

    it('drops the draft after 15 minutes', async () => {
      const { service } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));
      vi.setSystemTime(Date.now() + 16 * 60_000);
      const res = await service.handle(click(`st:${EVENT_ID}`, [S1]));
      expect(res.data?.content).toMatch(/timed out/);
      expect(res.data?.components).toEqual([]);
    });

    it('cancel discards the draft', async () => {
      const { service } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));
      const res = await service.handle(click(`xx:${EVENT_ID}`));
      expect(res.type).toBe(7);
      expect(res.data?.components).toEqual([]);
      const after = await service.handle(click(`go:${EVENT_ID}`));
      expect(after.data?.content).toMatch(/timed out/);
    });

    it('keeps drafts separate per clicker and per event', async () => {
      const { service } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));
      await service.handle(click(`st:${EVENT_ID}`, [S1]));
      const other = await service.handle(click(`st:${EVENT_ID}`, [S1], { id: '300000000000000099' }));
      expect(other.data?.content).toMatch(/timed out/);
    });
  });

  describe('confirming a signup', () => {
    async function fillForm(service: DiscordInteractionsService) {
      await service.handle(click(`sg:${EVENT_ID}`));
      await service.handle(click(`st:${EVENT_ID}`, [S1, S2, S3]));
      await service.handle(click(`fc:${EVENT_ID}`, [S3]));
      await service.handle(click(`cl:${EVENT_ID}`, ['GT3']));
    }

    it('signs a member up through the portal path with a ranked preference and "any stint" hours', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      await fillForm(service);

      const res = await service.handle(click(`go:${EVENT_ID}`));

      expect(eventsService.signup).toHaveBeenCalledWith(EVENT_ID, 'user-1', {
        timeslotIds: [S1, S2, S3],
        timeslotPreference: [S3, S1, S2],
        carClass: 'GT3',
        availableHours: [],
      });
      expect(res.type).toBe(7);
      expect(res.data?.components).toEqual([]);
      expect(res.data?.content).toBe(
        "✅ You're signed up for **GES Le Mans 24h**: 1st Sun 25 Oct · 09:00 UTC, 2nd Sat 24 Oct · 13:00 UTC, 3rd Sat 24 Oct · 20:00 UTC · GT3. " +
          "Your hours are set to 'any stint' — tap **Set my hours** on the event post to give exact availability.",
      );
    });

    it('defaults the first choice to the earliest selected start time', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      await service.handle(click(`sg:${EVENT_ID}`));
      await service.handle(click(`st:${EVENT_ID}`, [S3, S2]));
      await service.handle(click(`cl:${EVENT_ID}`, ['LMP2']));
      await service.handle(click(`go:${EVENT_ID}`));
      expect(eventsService.signup.mock.calls[0][2]).toMatchObject({ timeslotPreference: [S2, S3], carClass: 'LMP2' });
    });

    it('signs a guest up through the guest service', async () => {
      const { service, guestSignupsService, eventsService } = makeService({ profile: guestProfile });
      await fillForm(service);

      const res = await service.handle(click(`go:${EVENT_ID}`));

      expect(guestSignupsService.upsert).toHaveBeenCalledWith(EVENT_ID, 'profile-g', {
        timeslotIds: [S1, S2, S3],
        timeslotPreference: [S3, S1, S2],
        carClass: 'GT3',
      });
      expect(eventsService.signup).not.toHaveBeenCalled();
      expect(res.data?.content).toMatch(/^✅ You're signed up for/);
    });

    it('surfaces service validation errors in plain words and keeps the form', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      eventsService.signup.mockRejectedValueOnce(new ForbiddenException('That car class is not offered for this event'));
      await fillForm(service);

      const res = await service.handle(click(`go:${EVENT_ID}`));

      expect(res.data?.content).toMatch(/^❌ That car class is not offered for this event\n\n/);
      expect(ids(res)).toEqual(['st', 'fc', 'cl', 'go']);

      // The draft survived, so a retry works.
      await service.handle(click(`go:${EVENT_ID}`));
      expect(eventsService.signup).toHaveBeenCalledTimes(2);
    });

    it('does not sign up when the event closed while the form was open', async () => {
      const { service, eventsService, eventsRepository } = makeService({ user: memberUser });
      await fillForm(service);
      eventsRepository.findOne.mockResolvedValue(makeEvent({ status: EventStatus.SIGNUPS_CLOSED }));
      const res = await service.handle(click(`go:${EVENT_ID}`));
      expect(res.data?.content).toBe('Signups for this event are closed.');
      expect(eventsService.signup).not.toHaveBeenCalled();
    });

    it('turns an unexpected failure into a generic message', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      eventsService.signup.mockRejectedValueOnce(new Error('db down'));
      await fillForm(service);
      const res = await service.handle(click(`go:${EVENT_ID}`));
      expect(res.data?.content).toMatch(/^❌ Something went wrong/);
    });
  });

  describe('already signed up', () => {
    it('pre-fills a member form from the existing signup and keeps their exact hours', async () => {
      const { service, eventsService } = makeService({
        user: memberUser,
        signup: {
          status: SignupStatus.CONFIRMED,
          carClass: 'LMP2',
          timeslotPreference: [S2, S1],
          availableHours: [new Date('2026-10-24T14:00:00Z')],
          timeslots: [{ id: S1 }, { id: S2 }],
        },
      });

      const res = await service.handle(click(`sg:${EVENT_ID}`));

      expect(res.data?.content).toMatch(/^\*\*Update your signup/);
      expect(ids(res)).toEqual(['st', 'fc', 'cl', 'go']);
      expect(rows(res)[0].components[0].options?.filter((o) => o.default).map((o) => o.value)).toEqual([S1, S2]);
      expect(rows(res)[1].components[0].options?.find((o) => o.default)?.value).toBe(S2);
      expect(rows(res)[2].components[0].options?.find((o) => o.default)?.value).toBe('LMP2');
      expect(confirmButton(res).disabled).toBe(false);

      const done = await service.handle(click(`go:${EVENT_ID}`));
      const dto = eventsService.signup.mock.calls[0][2];
      expect(dto).toEqual({ timeslotIds: [S1, S2], timeslotPreference: [S2, S1], carClass: 'LMP2' });
      expect(dto).not.toHaveProperty('availableHours');
      expect(done.data?.content).toContain('Your exact stint hours were kept.');
    });

    it('treats a cancelled signup as a fresh one', async () => {
      const { service } = makeService({
        user: memberUser,
        signup: { status: SignupStatus.CANCELLED, carClass: 'GT3', timeslotPreference: null, availableHours: [], timeslots: [{ id: S1 }] },
      });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toMatch(/^\*\*Sign up/);
      expect(rows(res)[0].components[0].options?.some((o) => o.default)).toBe(false);
    });

    it('pre-fills a guest from the guest signup', async () => {
      const { service } = makeService({
        profile: guestProfile,
        guestSignup: { status: 'CONFIRMED', carClass: 'GT3', timeslotIds: [S2], timeslotPreference: null },
      });
      const res = await service.handle(click(`sg:${EVENT_ID}`));
      expect(res.data?.content).toMatch(/^\*\*Update your signup/);
      expect(rows(res)[0].components[0].options?.filter((o) => o.default).map((o) => o.value)).toEqual([S2]);
      expect(rows(res)[1].components[0].options?.find((o) => o.default)?.value).toBe('GT3');
      expect(confirmButton(res).disabled).toBe(false);
    });
  });

  describe('withdrawing', () => {
    it('cancels a member signup', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      const res = await service.handle(click(`wd:${EVENT_ID}`));
      expect(eventsService.cancelSignup).toHaveBeenCalledWith(EVENT_ID, 'user-1');
      expect(res).toMatchObject({ type: 4, data: { content: "You've been withdrawn.", flags: 64 } });
    });

    it('says so when a member was not signed up', async () => {
      const { service, eventsService } = makeService({ user: memberUser });
      eventsService.cancelSignup.mockRejectedValueOnce(new NotFoundException('No active signup found'));
      const res = await service.handle(click(`wd:${EVENT_ID}`));
      expect(res.data?.content).toBe("You weren't signed up.");
    });

    it('cancels a guest signup', async () => {
      const { service, guestSignupsService } = makeService({
        profile: guestProfile,
        guestSignup: { status: 'CONFIRMED', timeslotIds: [S1] },
      });
      const res = await service.handle(click(`wd:${EVENT_ID}`));
      expect(guestSignupsService.cancel).toHaveBeenCalledWith(EVENT_ID, 'profile-g');
      expect(res.data?.content).toBe("You've been withdrawn.");
    });

    it('says so when a guest was not signed up', async () => {
      const { service, guestSignupsService } = makeService({ profile: guestProfile });
      const res = await service.handle(click(`wd:${EVENT_ID}`));
      expect(guestSignupsService.cancel).not.toHaveBeenCalled();
      expect(res.data?.content).toBe("You weren't signed up.");
    });

    it('works after signups closed (withdrawing is always allowed)', async () => {
      const { service, eventsService } = makeService({ user: memberUser, event: makeEvent({ status: EventStatus.SIGNUPS_CLOSED }) });
      const res = await service.handle(click(`wd:${EVENT_ID}`));
      expect(eventsService.cancelSignup).toHaveBeenCalled();
      expect(res.data?.content).toBe("You've been withdrawn.");
    });
  });
});
