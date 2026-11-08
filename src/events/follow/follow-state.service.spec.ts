import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import { Sim } from '../../common/enums/sim.enum.js';
import { FollowStateService } from './follow-state.service.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const STRATEGY_TOKEN = 'STRATEGYstrategySTRATEGYstrategy_-0123456';

/** A plan as the plan page publishes it: same stints as the fixture, with fuel/tyres. */
function publishedPlan(overrides: Record<string, unknown> = {}) {
  return {
    publishedAt: '2026-10-24T13:30:00.000Z',
    stints: [
      { id: 's1', startsAt: '2026-10-24T13:10:00.000Z', endsAt: '2026-10-24T14:30:00.000Z', fuelLiters: 98.5, tyres: null },
      { id: 's2', startsAt: '2026-10-24T14:31:30.000Z', endsAt: '2026-10-24T15:50:00.000Z', fuelLiters: 98.5, tyres: 4 },
      { id: 's3', startsAt: '2026-10-24T15:51:00.000Z', endsAt: '2026-10-24T16:10:00.000Z', fuelLiters: 41.2, tyres: 0 },
    ],
    ...overrides,
  };
}

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
    strategyToken: STRATEGY_TOKEN,
    followNames: 'FULL',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** The original plan: stint 1 was planned to start at 13:10, two minutes before it really did. */
function baseline(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: '2026-10-24T13:00:00.000Z',
    source: 'AUTO',
    stints: [
      { id: 's1', startsAt: '2026-10-24T13:10:00.000Z', endsAt: '2026-10-24T14:10:00.000Z' },
      { id: 's2', startsAt: '2026-10-24T14:11:00.000Z', endsAt: '2026-10-24T15:11:00.000Z' },
    ],
    ...overrides,
  };
}

function setup(
  opts: { team?: unknown; event?: Record<string, unknown> | null; followNames?: string; plan?: unknown; baseline?: unknown } = {},
) {
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
    // Routed like the real queries: by public token, by strategy token, or the select:false plan column.
    teams: {
      findOne: vi.fn(async (query: { where: Record<string, unknown> }) => {
        const row = team as { followToken?: string; strategyToken?: string } | null;
        if (row === null) return null;
        if ('followToken' in query.where) return query.where.followToken === row.followToken ? row : null;
        if ('strategyToken' in query.where) return query.where.strategyToken === row.strategyToken ? row : null;
        return { id: 't1', publishedPlan: opts.plan ?? null, planBaseline: opts.baseline ?? null };
      }),
    },
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
    expect(Object.keys(state.team).sort()).toEqual(['carName', 'name', 'simStartTimeOfDay']);
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
    expect(state.team).toEqual({ name: 'W2W #1', carName: 'BMW M4 GT3', simStartTimeOfDay: '14:00' });
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

describe('FollowStateService strategy link and published plan', () => {
  it('the public token never carries strategy, even when a plan with fuel is published', async () => {
    const { service } = setup({ plan: publishedPlan(), baseline: baseline() });
    const state = await service.getState(TOKEN);
    expect(state.strategy).toBeUndefined();
    const json = JSON.stringify(state);
    expect(json).not.toContain('98.5');
    expect(json).not.toContain('41.2');
    expect(json).not.toContain('fuel');
    expect(json).not.toContain('tyres');
    expect(json).not.toContain('driftSeconds');
  });

  it('shows the published times on the public link too (so the page matches the planner)', async () => {
    const { service } = setup({ plan: publishedPlan() });
    const state = await service.getState(TOKEN);
    expect(state.stints.map((s) => [s.startsAt, s.endsAt])).toEqual([
      ['2026-10-24T13:10:00.000Z', '2026-10-24T14:30:00.000Z'],
      ['2026-10-24T14:31:30.000Z', '2026-10-24T15:50:00.000Z'],
      ['2026-10-24T15:51:00.000Z', '2026-10-24T16:10:00.000Z'],
    ]);
  });

  it('the strategy token returns the same data plus fuel, tyres and the drift against the original plan', async () => {
    const { service } = setup({ plan: publishedPlan(), baseline: baseline() });
    const state = await service.getState(STRATEGY_TOKEN);
    expect(state.strategy).toEqual({
      stints: [
        { number: 1, fuelLiters: 98.5, tyres: null },
        { number: 2, fuelLiters: 98.5, tyres: 4 },
        { number: 3, fuelLiters: 41.2, tyres: 0 },
      ],
      driftSeconds: 120,
    });
    expect(state.stints[0].driverName).toBe('Alex Rivera');
    // never the secret tokens or driver ids
    expect(JSON.stringify(state)).not.toContain(STRATEGY_TOKEN);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  it('the strategy token without a published plan falls back to the stored-duration cascade, without strategy', async () => {
    const { service } = setup();
    const state = await service.getState(STRATEGY_TOKEN);
    expect(state.strategy).toBeUndefined();
    expect(state.stints[1].startsAt).toBe('2026-10-24T14:15:00.000Z');
  });

  it('ignores a published plan that no longer matches the stints (changed or reordered)', async () => {
    const stale = publishedPlan({
      stints: publishedPlan().stints.map((stint, index) => (index === 1 ? { ...stint, id: 'other' } : stint)),
    });
    const { service } = setup({ plan: stale });
    const strategy = await service.getState(STRATEGY_TOKEN);
    expect(strategy.strategy).toBeUndefined();
    expect(strategy.stints[1].startsAt).toBe('2026-10-24T14:15:00.000Z');

    const shorter = setup({ plan: publishedPlan({ stints: publishedPlan().stints.slice(0, 2) }) });
    expect((await shorter.service.getState(STRATEGY_TOKEN)).strategy).toBeUndefined();
  });

  it('the drift is measured against the saved original plan and ignores the live plan', async () => {
    // The live plan says stint 1 started at 13:10 (so no delay), but the ORIGINAL plan had it at 13:00.
    const early = baseline({ stints: [{ id: 's1', startsAt: '2026-10-24T13:00:00.000Z', endsAt: '2026-10-24T14:00:00.000Z' }] });
    const { service } = setup({ plan: publishedPlan(), baseline: early });
    // stint 1 really started at 13:12 -> 12 minutes behind the original plan
    expect((await service.getState(STRATEGY_TOKEN)).strategy?.driftSeconds).toBe(720);
  });

  it('the drift is null without a saved original plan, or when no started stint is in it', async () => {
    expect((await setup({ plan: publishedPlan() }).service.getState(STRATEGY_TOKEN)).strategy?.driftSeconds).toBeNull();
    const unrelated = baseline({ stints: [{ id: 'gone', startsAt: '2026-10-24T13:10:00.000Z', endsAt: '2026-10-24T14:10:00.000Z' }] });
    expect(
      (await setup({ plan: publishedPlan(), baseline: unrelated }).service.getState(STRATEGY_TOKEN)).strategy?.driftSeconds,
    ).toBeNull();
  });

  it('the public token never carries the drift, with or without a baseline', async () => {
    const state = await setup({ plan: publishedPlan(), baseline: baseline() }).service.getState(TOKEN);
    expect(JSON.stringify(state)).not.toContain('driftSeconds');
  });

  it('resolveTarget accepts either token', async () => {
    const { service } = setup();
    await expect(service.resolveTarget(TOKEN)).resolves.toEqual({ teamId: 't1', eventId: 'e1' });
    await expect(service.resolveTarget(STRATEGY_TOKEN)).resolves.toEqual({ teamId: 't1', eventId: 'e1' });
  });
});
