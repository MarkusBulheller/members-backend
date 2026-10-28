import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { EventGuestSignupsService } from './event-guest-signups.service.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const OTHER = '99999999-9999-4999-8999-999999999999';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    status: EventStatus.PUBLISHED,
    carClasses: ['GTP', 'LMP2'],
    timeslots: [
      { id: T1, startsAt: new Date('2026-11-01T10:00:00Z') },
      { id: T2, startsAt: new Date('2026-11-01T14:00:00Z') },
      { id: T3, startsAt: new Date('2026-11-01T18:00:00Z') },
    ],
    ...overrides,
  };
}

function setup(opts: { event?: unknown; existing?: unknown; profile?: unknown } = {}) {
  const store: { current: Record<string, unknown> | null } = { current: (opts.existing as never) ?? null };
  const guestSignups = {
    findOne: vi.fn().mockImplementation(async () => store.current),
    find: vi.fn().mockResolvedValue([]),
    create: vi.fn((v: Record<string, unknown>) => ({ ...v })),
    save: vi.fn().mockImplementation(async (v: Record<string, unknown>) => {
      store.current = { id: 'g1', ...v };
      return store.current;
    }),
  };
  const events = {
    findOne: vi.fn().mockResolvedValue(opts.event === undefined ? makeEvent() : opts.event),
  };
  const profiles = {
    findOne: vi.fn().mockResolvedValue(
      opts.profile === undefined ? { id: 'p1', userId: null, displayName: 'Guest', iracingName: null } : opts.profile,
    ),
    find: vi.fn().mockResolvedValue([]),
  };
  const dummies = { createQueryBuilder: vi.fn() };
  const eventsService = { scheduleAnnouncementRefreshFor: vi.fn() };
  const dummyDriversService = { create: vi.fn().mockResolvedValue({ id: 'd1' }) };
  const planEvents = { emit: vi.fn() };
  const service = new EventGuestSignupsService(
    guestSignups as never,
    events as never,
    profiles as never,
    dummies as never,
    eventsService as never,
    dummyDriversService as never,
    planEvents as never,
  );
  return { service, guestSignups, events, profiles, dummies, eventsService, dummyDriversService, planEvents, store };
}

describe('EventGuestSignupsService.upsert', () => {
  it('creates a CONFIRMED signup, normalises the ranking and notifies plan + Discord', async () => {
    const { service, guestSignups, planEvents, eventsService } = setup();

    const saved = await service.upsert('e1', 'p1', {
      timeslotIds: [T1, T2],
      timeslotPreference: [T2, OTHER],
      carClass: 'GTP',
    });

    expect(saved).toMatchObject({
      eventId: 'e1',
      driverProfileId: 'p1',
      status: 'CONFIRMED',
      carClass: 'GTP',
      timeslotIds: [T1, T2],
      timeslotPreference: [T2, T1], // unknown id dropped, missing chosen slot appended
    });
    expect(guestSignups.save).toHaveBeenCalledTimes(1);
    expect(planEvents.emit).toHaveBeenCalledWith('e1', '*', 'drivers', undefined);
    expect(eventsService.scheduleAnnouncementRefreshFor).toHaveBeenCalledWith('e1');
  });

  it('is idempotent: signing up twice keeps one row and the same content', async () => {
    const ctx = setup();
    const first = await ctx.service.upsert('e1', 'p1', { timeslotIds: [T1], carClass: 'GTP' });
    const second = await ctx.service.upsert('e1', 'p1', { timeslotIds: [T1], carClass: 'GTP' });

    expect(second).toEqual(first);
    // The second call updates the stored row instead of creating another.
    expect(ctx.guestSignups.create).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates timeslot ids', async () => {
    const { service } = setup();
    const saved = await service.upsert('e1', 'p1', { timeslotIds: [T1, T1, T2] });
    expect(saved.timeslotIds).toEqual([T1, T2]);
  });

  it('leaves carClass alone when omitted, clears it on null, and re-activates a cancelled signup', async () => {
    const existing = {
      id: 'g1',
      eventId: 'e1',
      driverProfileId: 'p1',
      status: 'CANCELLED',
      carClass: 'GTP',
      timeslotIds: [T1],
      timeslotPreference: null,
    };
    const kept = setup({ existing: { ...existing } });
    expect(await kept.service.upsert('e1', 'p1', { timeslotIds: [T2] })).toMatchObject({
      status: 'CONFIRMED',
      carClass: 'GTP',
      timeslotIds: [T2],
    });

    const cleared = setup({ existing: { ...existing } });
    expect((await cleared.service.upsert('e1', 'p1', { timeslotIds: [T2], carClass: null })).carClass).toBeNull();
  });

  it('keeps an existing ranking (re-normalised to the new slots) unless one is sent; null clears it', async () => {
    const existing = {
      id: 'g1',
      eventId: 'e1',
      driverProfileId: 'p1',
      status: 'CONFIRMED',
      carClass: null,
      timeslotIds: [T1, T2],
      timeslotPreference: [T2, T1],
    };
    const kept = setup({ existing: { ...existing } });
    expect((await kept.service.upsert('e1', 'p1', { timeslotIds: [T1, T3] })).timeslotPreference).toEqual([T1, T3]);

    const same = setup({ existing: { ...existing } });
    expect((await same.service.upsert('e1', 'p1', { timeslotIds: [T1, T2] })).timeslotPreference).toEqual([T2, T1]);

    const cleared = setup({ existing: { ...existing } });
    expect(
      (await cleared.service.upsert('e1', 'p1', { timeslotIds: [T1, T2], timeslotPreference: null }))
        .timeslotPreference,
    ).toBeNull();
  });

  it('rejects an unknown event, a missing driver and a driver with a portal account', async () => {
    await expect(setup({ event: null }).service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(setup({ profile: null }).service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      setup({ profile: { id: 'p1', userId: 'u1' } }).service.upsert('e1', 'p1', { timeslotIds: [T1] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires at least one slot and only slots of this event', async () => {
    const { service, guestSignups } = setup();
    await expect(service.upsert('e1', 'p1', { timeslotIds: [] })).rejects.toThrow('at least one');
    await expect(service.upsert('e1', 'p1', { timeslotIds: [T1, OTHER] })).rejects.toBeInstanceOf(BadRequestException);
    expect(guestSignups.save).not.toHaveBeenCalled();
  });

  it("rejects a car class the event doesn't offer", async () => {
    const { service } = setup();
    await expect(service.upsert('e1', 'p1', { timeslotIds: [T1], carClass: 'GT3' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('follows the member signup openness rule', async () => {
    const draft = setup({ event: makeEvent({ status: EventStatus.DRAFT }) });
    await expect(draft.service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(ForbiddenException);

    // Closed: a newcomer (or a cancelled guest) is refused ...
    const closedNew = setup({ event: makeEvent({ status: EventStatus.SIGNUPS_CLOSED }) });
    await expect(closedNew.service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const closedCancelled = setup({
      event: makeEvent({ status: EventStatus.SIGNUPS_CLOSED }),
      existing: { id: 'g1', status: 'CANCELLED' },
    });
    await expect(closedCancelled.service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // ... but a guest who is already in may still adjust their slots.
    const closedActive = setup({
      event: makeEvent({ status: EventStatus.SIGNUPS_CLOSED }),
      existing: { id: 'g1', status: 'CONFIRMED', carClass: null, timeslotIds: [T1], timeslotPreference: null },
    });
    await expect(closedActive.service.upsert('e1', 'p1', { timeslotIds: [T2] })).resolves.toMatchObject({
      timeslotIds: [T2],
    });
  });

  it('turns a unique-index race into a 409', async () => {
    const { service, guestSignups } = setup();
    guestSignups.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(service.upsert('e1', 'p1', { timeslotIds: [T1] })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EventGuestSignupsService.cancel', () => {
  it('sets CANCELLED and notifies plan + Discord', async () => {
    const { service, guestSignups, planEvents, eventsService } = setup({
      existing: { id: 'g1', status: 'CONFIRMED' },
    });
    await service.cancel('e1', 'p1', 'admin-1');
    expect(guestSignups.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED' }));
    expect(planEvents.emit).toHaveBeenCalledWith('e1', '*', 'drivers', 'admin-1');
    expect(eventsService.scheduleAnnouncementRefreshFor).toHaveBeenCalledWith('e1');
  });

  it('does nothing (and does not throw) without an active signup', async () => {
    const none = setup();
    await expect(none.service.cancel('e1', 'p1')).resolves.toBeUndefined();
    const already = setup({ existing: { id: 'g1', status: 'CANCELLED' } });
    await expect(already.service.cancel('e1', 'p1')).resolves.toBeUndefined();
    expect(none.guestSignups.save).not.toHaveBeenCalled();
    expect(already.guestSignups.save).not.toHaveBeenCalled();
    expect(none.planEvents.emit).not.toHaveBeenCalled();
  });
});

describe('EventGuestSignupsService reads', () => {
  it('findActiveByEvent returns only CONFIRMED rows in sign-up order with iracingName ?? displayName', async () => {
    const ctx = setup();
    ctx.guestSignups.find.mockResolvedValue([
      { id: 'g1', driverProfileId: 'p1', status: 'CONFIRMED' },
      { id: 'g2', driverProfileId: 'p2', status: 'CONFIRMED' },
    ]);
    ctx.profiles.find.mockResolvedValue([
      { id: 'p1', displayName: 'Guest One', iracingName: 'Iracing One' },
      { id: 'p2', displayName: 'Guest Two', iracingName: null },
    ]);

    const result = await ctx.service.findActiveByEvent('e1');

    expect(ctx.guestSignups.find).toHaveBeenCalledWith({
      where: { eventId: 'e1', status: 'CONFIRMED' },
      order: { signedUpAt: 'ASC' },
    });
    expect(result.map((r) => r.driverName)).toEqual(['Iracing One', 'Guest Two']);
  });

  it('findByEventAndProfile looks the pair up (any status)', async () => {
    const ctx = setup({ existing: { id: 'g1' } });
    await expect(ctx.service.findByEventAndProfile('e1', 'p1')).resolves.toEqual({ id: 'g1' });
    expect(ctx.guestSignups.findOne).toHaveBeenCalledWith({ where: { eventId: 'e1', driverProfileId: 'p1' } });
  });

  it('listViewsForEvent flags guests already placed on a team', async () => {
    const ctx = setup();
    ctx.guestSignups.find.mockResolvedValue([
      { id: 'g1', driverProfileId: 'p1', status: 'CONFIRMED' },
      { id: 'g2', driverProfileId: 'p2', status: 'CONFIRMED' },
    ]);
    ctx.profiles.find.mockResolvedValue([
      { id: 'p1', displayName: 'One', iracingName: null, avatarUrl: '/uploads/avatars/a.png' },
      { id: 'p2', displayName: 'Two', iracingName: null, avatarUrl: null },
    ]);
    const qb = {
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([{ driverProfileId: 'p2', eventTeamId: 't9' }]),
    };
    ctx.dummies.createQueryBuilder.mockReturnValue(qb);

    const views = await ctx.service.listViewsForEvent('e1');

    expect(views.map((v) => [v.driverName, v.onTeam, v.eventTeamId, v.avatarUrl])).toEqual([
      ['One', false, null, '/uploads/avatars/a.png'],
      ['Two', true, 't9', null],
    ]);
  });
});

describe('EventGuestSignupsService.placeOnTeam', () => {
  it('adds the guest to the team as a roster guest via the dummy-driver service', async () => {
    const ctx = setup({ existing: { id: 'g1', status: 'CONFIRMED' } });
    await expect(ctx.service.placeOnTeam('e1', 'p1', 't1', 'admin-1')).resolves.toEqual({ id: 'd1' });
    expect(ctx.dummyDriversService.create).toHaveBeenCalledWith('e1', 't1', { driverProfileId: 'p1' }, 'admin-1');
  });

  it('needs an active guest signup', async () => {
    const none = setup();
    await expect(none.service.placeOnTeam('e1', 'p1', 't1')).rejects.toBeInstanceOf(NotFoundException);
    const cancelled = setup({ existing: { id: 'g1', status: 'CANCELLED' } });
    await expect(cancelled.service.placeOnTeam('e1', 'p1', 't1')).rejects.toBeInstanceOf(NotFoundException);
    expect(none.dummyDriversService.create).not.toHaveBeenCalled();
  });

  it('surfaces the "already on a team" conflict from the dummy-driver service', async () => {
    const ctx = setup({ existing: { id: 'g1', status: 'CONFIRMED' } });
    ctx.dummyDriversService.create.mockRejectedValue(
      new ConflictException('This driver is already on a team in this event'),
    );
    await expect(ctx.service.placeOnTeam('e1', 'p1', 't2')).rejects.toThrow('already on a team');
  });
});
