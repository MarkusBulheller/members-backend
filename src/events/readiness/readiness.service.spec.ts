import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import { Sim } from '../../common/enums/sim.enum.js';
import { ReadinessService } from './readiness.service.js';

const START = new Date('2026-10-24T12:00:00.000Z');

function repo(rows: unknown[] = []) {
  return { find: vi.fn().mockResolvedValue(rows), findOne: vi.fn().mockResolvedValue(rows[0] ?? null) };
}

interface Setup {
  event?: Record<string, unknown> | null;
  forecast?: () => Promise<unknown[]>;
}

function build({ event, forecast }: Setup = {}) {
  const baseEvent =
    event === null
      ? null
      : {
          id: 'e1',
          status: EventStatus.PUBLISHED,
          sim: Sim.IRACING,
          raceLengthMinutes: 240,
          minDriversPerTeam: null,
          fuelLimitPercent: null,
          tyreLimit: null,
          iracingSeasonId: null,
          iracingRaceWeekNum: null,
          timeslots: [{ id: 'ts1', startsAt: START }],
          ...event,
        };
  const team = (id: string, name: string) => ({
    id,
    eventId: 'e1',
    name,
    carId: 'car1',
    iracingTeamId: 500,
    timeslotId: 'ts1',
    refuelDurationSeconds: '30',
    tyreChangeDurationSeconds: '60',
    partialTyreChangeSeconds: null,
    pitstopDrivethroughSeconds: '0',
    fuelTankCapacityLiters: null,
    lapTimeDrySeconds: '100',
    lapTimeWetSeconds: null,
    fuelUsagePerLapLiters: '3',
    raceStartOffsetMinutes: null,
    formationLapFuelLiters: null,
  });
  const repos = {
    events: { findOne: vi.fn().mockResolvedValue(baseEvent) },
    teams: repo([team('t1', 'Team One'), team('t2', 'Team Two')]),
    stints: repo([
      { id: 's1', eventTeamId: 't1', order: 1, driverUserId: 'u1', durationMinutes: '55', tyreChange: true, tyresChanged: null, actualStartAt: null, wetOverride: null },
      { id: 's2', eventTeamId: 't2', order: 1, driverUserId: 'u2', durationMinutes: '55', tyreChange: true, tyresChanged: null, actualStartAt: null, wetOverride: null },
    ]),
    driverSettings: repo([]),
    dummies: repo([]),
    signups: repo([
      { userId: 'u1', status: 'CONFIRMED', eventTeamId: 't1', availableHours: [] },
      { userId: 'u2', status: 'CONFIRMED', eventTeamId: 't2', availableHours: [] },
      { userId: 'u3', status: 'CONFIRMED', eventTeamId: null, availableHours: [] },
      { userId: 'u4', status: 'CANCELLED', eventTeamId: 't1', availableHours: [] },
    ]),
    guests: repo([]),
    profiles: repo([
      { id: 'p1', userId: 'u1', displayName: 'Una', iracingName: null, iracingCustomerId: '1001', maxSuccessiveStints: null, startingDriver: true, nightDriver: true },
      { id: 'p2', userId: 'u2', displayName: 'Dos', iracingName: 'Dos iR', iracingCustomerId: '1002', maxSuccessiveStints: null, startingDriver: false, nightDriver: true },
    ]),
    users: repo([{ id: 'u3', discordGlobalName: null, discordUsername: 'tres' }]),
    cars: repo([{ id: 'car1', tankCapacityLiters: '100.00' }]),
    roster: repo([{ teamId: 500, custId: 1001 }]),
  };
  const series = { getWeatherForecast: vi.fn(forecast ?? (() => Promise.resolve([]))) };
  const service = new ReadinessService(
    repos.events as never,
    repos.teams as never,
    repos.stints as never,
    repos.driverSettings as never,
    repos.dummies as never,
    repos.signups as never,
    repos.guests as never,
    repos.profiles as never,
    repos.users as never,
    repos.cars as never,
    repos.roster as never,
    series as never,
  );
  return { service, repos, series };
}

describe('ReadinessService.getReadiness', () => {
  it('admin: gets event-level checks and every team', async () => {
    const { service } = build();
    const result = await service.getReadiness('e1', true, 'admin-id');
    expect(result.teams.map((t) => t.teamId)).toEqual(['t1', 't2']);
    expect(result.event.length).toBeGreaterThan(0);
    // u3 is confirmed but on no team; the name comes from the Discord account (no driver profile)
    const unplaced = result.event.find((c) => c.id === 'event.unplaced-drivers');
    expect(unplaced?.status).toBe('FAIL');
    expect(unplaced?.detail).toContain('tres');
    // the roster guard uses iRacing cust ids: u2 (1002) is not on team 500's roster, but u2 is on t2
    const roster = result.teams[1].checks.find((c) => c.id === 'team.iracing-roster');
    expect(roster?.status).toBe('FAIL');
    expect(roster?.detail).toContain('Dos iR');
  });

  it('member: sees only the teams they are signed up on, with no event-level checks', async () => {
    const { service } = build();
    const result = await service.getReadiness('e1', false, 'u1');
    expect(result.teams.map((t) => t.teamId)).toEqual(['t1']);
    expect(result.event).toEqual([]);
    const total = result.teams[0].summary;
    expect(result.summary.blockers).toBe(total.blockers);
    expect(result.summary.passed).toBe(total.passed);
  });

  it('member whose signup is cancelled or not on a team sees nothing', async () => {
    const { service } = build();
    const cancelled = await service.getReadiness('e1', false, 'u4');
    expect(cancelled.teams).toEqual([]);
    expect(cancelled.summary.status).toBe('PENDING');
    const unplaced = await service.getReadiness('e1', false, 'u3');
    expect(unplaced.teams).toEqual([]);
  });

  it('a DRAFT event is 404 for members but readable by admins', async () => {
    const { service } = build({ event: { status: EventStatus.DRAFT } });
    await expect(service.getReadiness('e1', false, 'u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getReadiness('e1', true, 'admin')).resolves.toMatchObject({ eventId: 'e1' });
  });

  it('a missing event is 404', async () => {
    const { service } = build({ event: null });
    await expect(service.getReadiness('e1', true, 'admin')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('batches: every repository is queried at most once however many teams there are', async () => {
    const { service, repos } = build();
    await service.getReadiness('e1', true, 'admin');
    for (const [name, r] of Object.entries(repos)) {
      const calls = ('find' in r ? (r.find as ReturnType<typeof vi.fn>).mock.calls.length : 0) + (name === 'events' ? 1 : 0);
      expect(calls, name).toBeLessThanOrEqual(1);
    }
    expect(repos.stints.find).toHaveBeenCalledTimes(1);
    expect(repos.dummies.find).toHaveBeenCalledTimes(1);
  });

  it('loads the weather forecast only for a linked iRacing event and maps it into the night check', async () => {
    const forecast = vi.fn().mockResolvedValue([
      { time_offset: 0, is_sun_up: false, other: 1 },
      { time_offset: 'bad', is_sun_up: true },
    ]);
    const { service, series } = build({ event: { iracingSeasonId: 7, iracingRaceWeekNum: 2 }, forecast });
    const result = await service.getReadiness('e1', true, 'admin');
    expect(series.getWeatherForecast).toHaveBeenCalledWith(7, 2);
    // u1 opens the race in the dark and Una is a night driver; u2 is one too -> passes
    expect(result.teams[0].checks.find((c) => c.id === 'team.night-drivers')?.status).toBe('PASS');

    const unlinked = build();
    await unlinked.service.getReadiness('e1', true, 'admin');
    expect(unlinked.series.getWeatherForecast).not.toHaveBeenCalled();
  });

  it('a failing forecast never fails the endpoint: the night check becomes PENDING with the reason', async () => {
    const { service } = build({
      event: { iracingSeasonId: 7, iracingRaceWeekNum: 2 },
      forecast: () => Promise.reject(new Error('The stored weather forecast link has expired')),
    });
    const result = await service.getReadiness('e1', true, 'admin');
    const night = result.teams[0].checks.find((c) => c.id === 'team.night-drivers');
    expect(night?.status).toBe('PENDING');
    expect(night?.detail).toContain('expired');
  });

  it('an event with no teams does not query the per-team tables', async () => {
    const { service, repos } = build();
    repos.teams.find.mockResolvedValue([]);
    const result = await service.getReadiness('e1', true, 'admin');
    expect(result.teams).toEqual([]);
    expect(result.summary.status).toBe('PENDING');
    expect(repos.stints.find).not.toHaveBeenCalled();
    expect(repos.dummies.find).not.toHaveBeenCalled();
    expect(repos.driverSettings.find).not.toHaveBeenCalled();
  });
});
