import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import { Sim } from '../../common/enums/sim.enum.js';
import { FollowStateService } from './follow-state.service.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

/** Every field a real row could carry, including a lot that must never reach the public. */
function fullTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    eventId: 'e1',
    name: 'W2W #1',
    carId: 'car1',
    iracingTeamId: 4242,
    timeslotId: 'ts1',
    timeslot: { id: 'ts1', eventId: 'e1', startsAt: new Date('2026-10-24T13:00:00.000Z') },
    refuelDurationSeconds: '60',
    tyreChangeDurationSeconds: '120',
    partialTyreChangeSeconds: '5',
    pitstopDrivethroughSeconds: '0',
    fuelTankCapacityLiters: '100',
    lapTimeDrySeconds: '98.123',
    lapTimeWetSeconds: '110.5',
    fuelUsagePerLapLiters: '3.2',
    raceStartOffsetMinutes: '10',
    formationLapFuelLiters: '2',
    simStartTimeOfDay: '14:00',
    followToken: TOKEN,
    followNames: 'FULL',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(opts: { team?: unknown; event?: Record<string, unknown> | null; followNames?: string } = {}) {
  const team = opts.team === undefined ? fullTeam(opts.followNames ? { followNames: opts.followNames } : {}) : opts.team;
  const event =
    opts.event === undefined
      ? {
          id: 'e1',
          title: 'Spa 6h',
          description: 'secret briefing text',
          trackId: 'trk1',
          track: { id: 'trk1', name: 'Spa-Francorchamps' },
          startsAt: new Date('2026-10-24T12:00:00.000Z'),
          raceLengthMinutes: 360,
          status: EventStatus.PUBLISHED,
          sim: Sim.IRACING,
          fuelLimitPercent: '90',
          tyreLimit: 12,
          discordMessageId: 'dm1',
          createdByUserId: 'admin1',
        }
      : opts.event;
  const stints = [
    { id: 's1', eventTeamId: 't1', order: 0, driverUserId: 'u1', durationMinutes: '60', tyreChange: true, tyresChanged: null, actualStartAt: new Date('2026-10-24T13:12:00.000Z'), wetOverride: true },
    { id: 's2', eventTeamId: 't1', order: 1, driverUserId: 'd1', durationMinutes: '60', tyreChange: true, tyresChanged: null, actualStartAt: null, wetOverride: null },
    { id: 's3', eventTeamId: 't1', order: 2, driverUserId: null, durationMinutes: '30', tyreChange: false, tyresChanged: null, actualStartAt: null, wetOverride: null },
  ];
  const dummies = [{ id: 'd1', eventTeamId: 't1', name: 'Guest Gustav', driverProfileId: null, availableHours: [new Date()] }];
  const profiles = [
    {
      id: 'p1',
      userId: 'u1',
      iracingName: 'Alex Rivera',
      displayName: 'alexr',
      email: 'alex@example.com',
      discordId: '123',
      avatarUrl: 'https://cdn/avatar.png',
      iracingCustomerId: 99,
    },
  ];
  const repos = {
    events: { findOne: vi.fn().mockResolvedValue(event) },
    teams: { findOne: vi.fn().mockResolvedValue(team) },
    stints: { find: vi.fn().mockResolvedValue(stints) },
    dummies: { find: vi.fn().mockResolvedValue(dummies) },
    profiles: { find: vi.fn().mockResolvedValue(profiles) },
    cars: { findOne: vi.fn().mockResolvedValue({ id: 'car1', name: 'BMW M4 GT3', tankCapacityLiters: '100' }) },
  };
  const service = new FollowStateService(
    repos.events as never,
    repos.teams as never,
    repos.stints as never,
    repos.dummies as never,
    repos.profiles as never,
    repos.cars as never,
  );
  return { service, repos };
}

describe('FollowStateService.getState', () => {
  it('returns exactly the contract fields and nothing else (leak guard)', async () => {
    const { service } = setup();
    const state = await service.getState(TOKEN);

    expect(Object.keys(state).sort()).toEqual(['event', 'race', 'serverNow', 'stintCount', 'stints', 'team']);
    expect(Object.keys(state.event).sort()).toEqual(['sim', 'startsAt', 'title', 'trackName']);
    expect(Object.keys(state.team).sort()).toEqual(['carName', 'name']);
    expect(Object.keys(state.race).sort()).toEqual(['endsAt', 'lengthMinutes', 'startsAt']);
    for (const stint of state.stints) {
      expect(Object.keys(stint).sort()).toEqual(['driverName', 'endsAt', 'number', 'started', 'startsAt']);
    }

    // belt and braces: no sensitive value appears anywhere in the serialised payload
    const json = JSON.stringify(state);
    for (const secret of [
      TOKEN,
      'alex@example.com',
      'avatar.png',
      'alexr',
      'secret briefing text',
      'u1',
      'admin1',
      'dm1',
      '98.123',
      '3.2',
      'car1',
      '4242',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(Number.isNaN(Date.parse(state.serverNow))).toBe(false);
  });

  it('fills the contract: event, team, race clock and the stint cascade from the green flag', async () => {
    const { service } = setup();
    const state = await service.getState(TOKEN);

    expect(state.event).toEqual({
      title: 'Spa 6h',
      trackName: 'Spa-Francorchamps',
      sim: 'IRACING',
      startsAt: '2026-10-24T12:00:00.000Z',
    });
    expect(state.team).toEqual({ name: 'W2W #1', carName: 'BMW M4 GT3' });
    // timeslot 13:00 + 10 min offset; 360 min race
    expect(state.race).toEqual({
      startsAt: '2026-10-24T13:10:00.000Z',
      endsAt: '2026-10-24T19:10:00.000Z',
      lengthMinutes: 360,
    });
    // stint 1 re-anchored to its recorded start (13:12); pit = 1 min refuel + 2 min tyres; stint 3 is splash-and-go
    expect(state.stints).toEqual([
      { number: 1, driverName: 'Alex Rivera', startsAt: '2026-10-24T13:12:00.000Z', endsAt: '2026-10-24T14:12:00.000Z', started: true },
      { number: 2, driverName: 'Guest Gustav', startsAt: '2026-10-24T14:15:00.000Z', endsAt: '2026-10-24T15:15:00.000Z', started: false },
      { number: 3, driverName: null, startsAt: '2026-10-24T15:16:00.000Z', endsAt: '2026-10-24T15:46:00.000Z', started: false },
    ]);
    expect(state.stintCount).toBe(3);
  });

  it('uses the display name when a member has no iRacing name', async () => {
    const { service, repos } = setup();
    repos.profiles.find.mockResolvedValue([{ userId: 'u1', iracingName: null, displayName: 'Alex R' }]);
    const state = await service.getState(TOKEN);
    expect(state.stints[0].driverName).toBe('Alex R');
  });

  it('names mode FIRST / INITIALS applies to members and guests alike', async () => {
    const first = await setup({ followNames: 'FIRST' }).service.getState(TOKEN);
    expect(first.stints.map((s) => s.driverName)).toEqual(['Alex', 'Guest', null]);
    const initials = await setup({ followNames: 'INITIALS' }).service.getState(TOKEN);
    expect(initials.stints.map((s) => s.driverName)).toEqual(['A. R.', 'G. G.', null]);
  });

  it('a team without a timeslot has no clock: null race times and null stint times', async () => {
    const { service } = setup({ team: fullTeam({ timeslot: null, timeslotId: null }) });
    const state = await service.getState(TOKEN);
    expect(state.race).toEqual({ startsAt: null, endsAt: null, lengthMinutes: 360 });
    expect(state.stints.map((s) => [s.startsAt, s.endsAt])).toEqual([[null, null], [null, null], [null, null]]);
    expect(state.stints[0]).toMatchObject({ driverName: 'Alex Rivera', started: true });
    expect(state.stintCount).toBe(3);
  });

  it('a team with no stints and no car still works', async () => {
    const { service, repos } = setup({ team: fullTeam({ carId: null }) });
    repos.stints.find.mockResolvedValue([]);
    const state = await service.getState(TOKEN);
    expect(state.stints).toEqual([]);
    expect(state.stintCount).toBe(0);
    expect(state.team.carName).toBeNull();
    expect(repos.cars.findOne).not.toHaveBeenCalled();
  });

  it.each([EventStatus.DRAFT, EventStatus.CANCELLED])('%s event is a 404', async (status) => {
    const { service } = setup({
      event: { id: 'e1', title: 'x', track: { name: 't' }, startsAt: new Date(), raceLengthMinutes: 60, status, sim: Sim.IRACING },
    });
    await expect(service.getState(TOKEN)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resolveTarget(TOKEN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([EventStatus.PUBLISHED, EventStatus.SIGNUPS_CLOSED, EventStatus.COMPLETED])('%s event is visible', async (status) => {
    const { service } = setup({
      event: { id: 'e1', title: 'x', track: { name: 't' }, startsAt: new Date(), raceLengthMinutes: 60, status, sim: Sim.IRACING },
    });
    await expect(service.resolveTarget(TOKEN)).resolves.toEqual({ teamId: 't1', eventId: 'e1' });
  });

  it('unknown token, malformed token and missing event all give the same 404', async () => {
    const unknown = setup({ team: null });
    const malformed = setup();
    const noEvent = setup({ event: null });
    const errors = await Promise.all([
      unknown.service.getState(TOKEN).catch((e: NotFoundException) => e),
      malformed.service.getState('short').catch((e: NotFoundException) => e),
      noEvent.service.getState(TOKEN).catch((e: NotFoundException) => e),
    ]);
    for (const e of errors) expect(e).toBeInstanceOf(NotFoundException);
    expect(new Set(errors.map((e) => JSON.stringify((e as NotFoundException).getResponse()))).size).toBe(1);
    // a malformed token never reaches the database
    expect(malformed.repos.teams.findOne).not.toHaveBeenCalled();
  });

  it('looks the team up by token only', async () => {
    const { service, repos } = setup();
    await service.getState(TOKEN);
    expect(repos.teams.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { followToken: TOKEN } }));
  });
});
