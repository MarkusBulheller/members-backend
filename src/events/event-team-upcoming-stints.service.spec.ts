import { describe, expect, it, vi } from 'vitest';
import { buildStintSlots, EventTeamUpcomingStintsService } from './event-team-upcoming-stints.service.js';

const START = Date.parse('2026-10-24T13:00:00.000Z');
const team = { refuelDurationSeconds: '60', tyreChangeDurationSeconds: '120', pitstopDrivethroughSeconds: '0' };

function stint(driverUserId: string | null, durationMinutes: string | null, extra: Record<string, unknown> = {}) {
  return { driverUserId, durationMinutes, tyreChange: true, actualStartAt: null, ...extra };
}

describe('buildStintSlots', () => {
  it('chains stints with pit time between them and flags the requesting driver', () => {
    const slots = buildStintSlots(
      team,
      [stint('u1', '60'), stint('u2', '60'), stint('u1', '30')],
      START,
      'u1',
      (id) => ({ u1: 'Jonas', u2: 'Lena' })[id] ?? null,
    );
    // pit stop = 1 min refuel + 2 min tyres = 3 min
    expect(slots.map((s) => [s.startsAt, s.endsAt])).toEqual([
      ['2026-10-24T13:00:00.000Z', '2026-10-24T14:00:00.000Z'],
      ['2026-10-24T14:03:00.000Z', '2026-10-24T15:03:00.000Z'],
      ['2026-10-24T15:06:00.000Z', '2026-10-24T15:36:00.000Z'],
    ]);
    expect(slots.map((s) => s.isMine)).toEqual([true, false, true]);
    expect(slots.map((s) => s.driverName)).toEqual(['Jonas', 'Lena', 'Jonas']);
  });

  it('skips the tyre change for a splash-and-go stint', () => {
    const slots = buildStintSlots(team, [stint('u1', '60'), stint('u1', '60', { tyreChange: false })], START, 'u1', () => null);
    expect(slots[1].startsAt).toBe('2026-10-24T14:01:00.000Z');
  });

  it('LMU: prices the tyre portion per tyre (0 / up to 2 / more than 2)', () => {
    // pit = 1 min refuel + tyre portion; team tyre change 120 s, default partial 5 s
    const startsFor = (tyresChanged: number, t: Record<string, unknown> = team) =>
      buildStintSlots(
        t as never,
        [stint('u1', '60'), stint('u1', '60', { tyresChanged, tyreChange: tyresChanged > 0 })],
        START,
        'u1',
        () => null,
        'LMU' as never,
      )[1].startsAt;
    expect(startsFor(0)).toBe('2026-10-24T14:01:00.000Z');
    expect(startsFor(2)).toBe('2026-10-24T14:01:05.000Z');
    expect(startsFor(3)).toBe('2026-10-24T14:03:00.000Z');
    // team-specific partial time wins over the 5 s fallback
    expect(startsFor(1, { ...team, partialTyreChangeSeconds: '10' })).toBe('2026-10-24T14:01:10.000Z');
  });

  it('iRacing: ignores tyresChanged and uses the boolean', () => {
    const slots = buildStintSlots(
      team,
      [stint('u1', '60'), stint('u1', '60', { tyresChanged: 1 })],
      START,
      'u1',
      () => null,
      'IRACING' as never,
    );
    expect(slots[1].startsAt).toBe('2026-10-24T14:03:00.000Z');
  });

  it('re-anchors on a recorded actual start', () => {
    const actual = new Date('2026-10-24T14:10:00.000Z');
    const slots = buildStintSlots(team, [stint('u1', '60'), stint('u2', '60', { actualStartAt: actual })], START, 'u1', () => null);
    expect(slots[1].startsAt).toBe('2026-10-24T14:10:00.000Z');
    expect(slots[1].endsAt).toBe('2026-10-24T15:10:00.000Z');
  });

  it('handles unassigned stints and missing durations', () => {
    const slots = buildStintSlots(team, [stint(null, null)], START, 'u1', () => 'x');
    expect(slots).toEqual([
      { startsAt: '2026-10-24T13:00:00.000Z', endsAt: '2026-10-24T13:00:00.000Z', isMine: false, driverName: null },
    ]);
  });
});

describe('EventTeamUpcomingStintsService.findForUser', () => {
  function makeService(assignments: unknown[]) {
    const eventsService = { findUpcomingStintAssignmentsForUser: vi.fn().mockResolvedValue(assignments) };
    const eventsRepository = { find: vi.fn().mockResolvedValue([{ id: 'e1', track: { name: 'Road Atlanta' } }]) };
    const teamsRepository = { find: vi.fn().mockResolvedValue([{ id: 't1', ...team }, { id: 't2', ...team }]) };
    const stintsRepository = {
      find: vi.fn().mockResolvedValue([
        { eventTeamId: 't1', ...stint('u1', '60') },
        { eventTeamId: 't1', ...stint('d1', '60') },
      ]),
    };
    const dummiesRepository = { find: vi.fn().mockResolvedValue([{ id: 'd1', name: 'Guest Gary' }]) };
    const driverProfilesRepository = {
      find: vi.fn().mockResolvedValue([{ userId: 'u1', displayName: 'Jonas', iracingName: 'Jonas Kurz' }]),
    };
    const service = new EventTeamUpcomingStintsService(
      eventsService as never,
      eventsRepository as never,
      teamsRepository as never,
      stintsRepository as never,
      dummiesRepository as never,
      driverProfilesRepository as never,
    );
    return { service, eventsService, stintsRepository };
  }

  const base = {
    eventId: 'e1',
    eventTitle: 'Petit',
    teamName: 'Red',
    raceLengthMinutes: 600,
    isLive: false,
    nextStintStartsAt: null,
  };

  it('adds trackName and the crew rotation with names and isMine', async () => {
    const { service } = makeService([{ ...base, teamId: 't1', timeslotStartsAt: '2026-10-24T13:00:00.000Z' }]);
    const [result] = await service.findForUser('u1');
    expect(result.trackName).toBe('Road Atlanta');
    expect(result.stints).toHaveLength(2);
    expect(result.stints[0]).toMatchObject({ isMine: true, driverName: 'Jonas Kurz' });
    expect(result.stints[1]).toMatchObject({ isMine: false, driverName: 'Guest Gary' });
  });

  it('returns an empty stints array when no plan is saved or no timeslot is committed', async () => {
    const { service } = makeService([
      { ...base, teamId: 't2', timeslotStartsAt: '2026-10-24T13:00:00.000Z' },
      { ...base, teamId: 't1', timeslotStartsAt: null },
    ]);
    const result = await service.findForUser('u1');
    expect(result.map((r) => r.stints)).toEqual([[], []]);
  });

  it('short-circuits with no assignments', async () => {
    const { service, stintsRepository } = makeService([]);
    expect(await service.findForUser('u1')).toEqual([]);
    expect(stintsRepository.find).not.toHaveBeenCalled();
  });
});
