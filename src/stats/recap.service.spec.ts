import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEANEST_MIN_LAPS, RECAP_TTL_MS, RecapService, stintDriveMs } from './recap.service.js';

interface FakeFindOperator {
  type: string;
  value: unknown;
}

/** Evaluates the subset of TypeORM find operators the service uses, so the mocked repository
 * actually applies the year / team filters the service builds. */
function matches(operator: unknown, actual: unknown): boolean {
  const op = operator as FakeFindOperator;
  switch (op.type) {
    case 'and':
      return (op.value as unknown[]).every((child) => matches(child, actual));
    case 'moreThanOrEqual':
      return (actual as Date).getTime() >= (op.value as Date).getTime();
    case 'lessThan':
      return (actual as Date).getTime() < (op.value as Date).getTime();
    case 'in':
      return (op.value as unknown[]).includes(actual);
    default:
      throw new Error(`unsupported operator ${op.type}`);
  }
}

interface FakeResult {
  id: string;
  teamId: number;
  trackId: string | null;
  trackName: string;
  trackConfig: string | null;
  carId: string | null;
  carName: string | null;
  seriesName: string | null;
  startTime: Date | null;
  endTime: Date | null;
  finishingPosition: number | null;
  finishingPositionInClass: number | null;
  teamLapsComplete: number | null;
  teamIncidents: number | null;
}

function result(id: string, over: Partial<FakeResult> = {}): FakeResult {
  return {
    id,
    teamId: 100,
    trackId: 't1',
    trackName: 'Spa',
    trackConfig: null,
    carId: 'c1',
    carName: 'BMW M4 GT3',
    seriesName: 'IMSA',
    startTime: new Date('2026-03-01T10:00:00Z'),
    endTime: new Date('2026-03-01T14:00:00Z'),
    finishingPosition: 5,
    finishingPositionInClass: null,
    teamLapsComplete: null,
    teamIncidents: null,
    ...over,
  };
}

interface FakeStint {
  raceResultId: string;
  iracingCustId: number;
  driverProfileId: string | null;
  displayName: string;
  averageLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  incidents: number | null;
  lapsComplete: number | null;
}

function stint(raceResultId: string, cust: number, name: string, over: Partial<FakeStint> = {}): FakeStint {
  return {
    raceResultId,
    iracingCustId: cust,
    driverProfileId: `p${cust}`,
    displayName: name,
    averageLapTimeMs: 100_000,
    bestLapTimeMs: 95_000,
    incidents: 0,
    lapsComplete: 10,
    ...over,
  };
}

function makeService(
  results: FakeResult[],
  stints: FakeStint[],
  teams: { teamId: number; teamName: string; active: boolean }[] = [],
) {
  const pairs = [
    ...new Map(
      results.map((r) => {
        const year = r.startTime ? r.startTime.getUTCFullYear() : null;
        return [`${year}|${r.teamId}`, { year, teamId: r.teamId }] as const;
      }),
    ).values(),
  ];
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['select', 'addSelect', 'distinct']) qb[name] = vi.fn().mockReturnValue(qb);
  qb.getRawMany = vi.fn().mockResolvedValue(pairs);
  const resultsRepo = {
    createQueryBuilder: vi.fn().mockReturnValue(qb),
    find: vi.fn().mockImplementation(async ({ where }: { where: { startTime: unknown; teamId?: unknown } }) =>
      results.filter(
        (r) =>
          r.startTime !== null &&
          matches(where.startTime, r.startTime) &&
          (where.teamId === undefined || matches(where.teamId, r.teamId)),
      ),
    ),
  };
  const stintsRepo = {
    find: vi.fn().mockImplementation(async ({ where }: { where: { raceResultId: unknown } }) =>
      stints.filter((s) => matches(where.raceResultId, s.raceResultId)),
    ),
  };
  const teamsRepo = { find: vi.fn().mockResolvedValue(teams) };
  const service = new RecapService(resultsRepo as never, stintsRepo as never, teamsRepo as never);
  return { service, resultsRepo, stintsRepo, teamsRepo };
}

describe('stintDriveMs', () => {
  it('is average lap x laps, null when an input is missing or not positive', () => {
    expect(stintDriveMs({ averageLapTimeMs: 90_000, lapsComplete: 10 })).toBe(900_000);
    expect(stintDriveMs({ averageLapTimeMs: null, lapsComplete: 10 })).toBeNull();
    expect(stintDriveMs({ averageLapTimeMs: 90_000, lapsComplete: 0 })).toBeNull();
    expect(stintDriveMs({ averageLapTimeMs: -1, lapsComplete: 5 })).toBeNull();
  });
});

describe('RecapService.getRecap', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('an empty year gives zeros and empty arrays', async () => {
    const { service, stintsRepo } = makeService([], []);
    const recap = await service.getRecap({ year: 2026, teamId: null });
    expect(recap).toMatchObject({
      year: 2026,
      teamId: null,
      teamName: null,
      availableYears: [],
      teams: [],
      totals: {
        races: 0,
        laps: 0,
        driveMs: 0,
        wins: 0,
        podiums: 0,
        topTens: 0,
        incidents: 0,
        avgFinish: null,
        bestFinish: null,
        avgIncidentsPerRace: null,
      },
      longestRace: null,
      bestResult: null,
      topTracks: [],
      topCars: [],
      topSeries: [],
      drivers: [],
      awards: [],
      firsts: { firstRace: null, lastRace: null },
    });
    expect(recap.byMonth).toHaveLength(12);
    expect(recap.byMonth.every((m) => m.races === 0 && m.podiums === 0)).toBe(true);
    expect(stintsRepo.find).not.toHaveBeenCalled();
  });

  it('computes the totals; positions use class position when present, else overall', async () => {
    const results = [
      result('r1', { finishingPosition: 5, finishingPositionInClass: 1, teamLapsComplete: 110, teamIncidents: 12 }), // P1
      result('r2', { finishingPosition: 3, startTime: new Date('2026-05-10T10:00:00Z') }), // P3
      result('r3', { finishingPosition: 8, finishingPositionInClass: 2, startTime: new Date('2026-05-11T10:00:00Z') }), // P2
      result('r4', { finishingPosition: 12, startTime: new Date('2026-06-01T10:00:00Z') }), // P12
      result('r5', { finishingPosition: null, startTime: new Date('2026-07-01T10:00:00Z') }), // unranked
      result('r6', { finishingPosition: 0, startTime: new Date('2026-07-02T10:00:00Z') }), // 0 = no position
    ];
    const stints = [
      stint('r1', 1, 'Alice', { lapsComplete: 100, averageLapTimeMs: 60_000, incidents: 10 }),
      stint('r1', 2, 'Bob', { lapsComplete: 10, averageLapTimeMs: 60_000, incidents: 2 }),
      stint('r2', 1, 'Alice', { lapsComplete: 20, averageLapTimeMs: 90_000, incidents: 4 }),
      stint('r3', 2, 'Bob', { lapsComplete: 30, averageLapTimeMs: null, incidents: null }),
    ];
    const { service } = makeService(results, stints);
    const { totals } = await service.getRecap({ year: 2026, teamId: null });
    expect(totals.races).toBe(6);
    // r1 uses teamLapsComplete (110), r2 and r3 the summed stints (20, 30), the rest none.
    expect(totals.laps).toBe(110 + 20 + 30);
    // 100*60s + 10*60s + 20*90s; Bob's r3 stint has no average lap -> contributes nothing.
    expect(totals.driveMs).toBe(6_000_000 + 600_000 + 1_800_000);
    expect(totals.wins).toBe(1);
    expect(totals.podiums).toBe(3);
    expect(totals.topTens).toBe(3);
    expect(totals.bestFinish).toBe(1);
    expect(totals.avgFinish).toBe(4.5); // (1+3+2+12)/4
    // r1 teamIncidents 12; r2 summed stints 4; r3 had no incident data (excluded); r4-r6 no stints.
    expect(totals.incidents).toBe(16);
    expect(totals.avgIncidentsPerRace).toBe(8);
  });

  it('only counts races inside [Jan 1, next Jan 1) UTC', async () => {
    const results = [
      result('before', { startTime: new Date('2025-12-31T23:59:59.999Z') }),
      result('first', { startTime: new Date('2026-01-01T00:00:00.000Z') }),
      result('last', { startTime: new Date('2026-12-31T23:59:59.999Z') }),
      result('after', { startTime: new Date('2027-01-01T00:00:00.000Z') }),
    ];
    const { service } = makeService(results, []);
    const recap = await service.getRecap({ year: 2026, teamId: null });
    expect(recap.totals.races).toBe(2);
    expect(recap.byMonth[0].races).toBe(1);
    expect(recap.byMonth[11].races).toBe(1);
    expect(recap.availableYears).toEqual([2027, 2026, 2025]);
    expect(recap.firsts.firstRace?.date).toBe('2026-01-01T00:00:00.000Z');
    expect(recap.firsts.lastRace?.date).toBe('2026-12-31T23:59:59.999Z');
  });

  it('defaults to the current year, or the latest year with results when this one has none', async () => {
    const withCurrent = makeService([result('a'), result('b', { startTime: new Date('2025-05-01T10:00:00Z') })], []);
    expect((await withCurrent.service.getRecap({ year: null, teamId: null })).year).toBe(2026);
    const withoutCurrent = makeService([result('a', { startTime: new Date('2025-05-01T10:00:00Z') })], []);
    const recap = await withoutCurrent.service.getRecap({ year: null, teamId: null });
    expect(recap.year).toBe(2025);
    expect(recap.totals.races).toBe(1);
  });

  it('filters by team on the absolute id, so negative ids match both ways', async () => {
    const results = [result('a', { teamId: 100 }), result('b', { teamId: -100 }), result('c', { teamId: 200 })];
    const teams = [
      { teamId: 100, teamName: 'W2W Alpha', active: true },
      { teamId: -200, teamName: 'W2W Beta', active: true },
      { teamId: 300, teamName: 'Inactive, no results', active: false },
    ];
    const { service } = makeService(results, [], teams);
    const all = await service.getRecap({ year: 2026, teamId: null });
    expect(all.totals.races).toBe(3);
    expect(all.teams).toEqual([
      { teamId: 100, teamName: 'W2W Alpha' },
      { teamId: 200, teamName: 'W2W Beta' },
    ]);

    const negative = await service.getRecap({ year: 2026, teamId: -100 });
    expect(negative.totals.races).toBe(2);
    expect(negative.teamId).toBe(100);
    expect(negative.teamName).toBe('W2W Alpha');

    const positive = await service.getRecap({ year: 2026, teamId: 200 });
    expect(positive.totals.races).toBe(1);
    expect(positive.teamName).toBe('W2W Beta');
  });

  it('lists inactive teams that appear in results and falls back to "Team <id>" for unknown ones', async () => {
    const { service } = makeService([result('a', { teamId: -999 })], [], [{ teamId: 999, teamName: 'Old squad', active: false }]);
    expect((await service.getRecap({ year: 2026, teamId: null })).teams).toEqual([{ teamId: 999, teamName: 'Old squad' }]);
    const unknown = makeService([result('a', { teamId: 42 })], []);
    expect((await unknown.service.getRecap({ year: 2026, teamId: 42 })).teamName).toBe('Team 42');
  });

  it('buckets months and podiums in UTC', async () => {
    const results = [
      result('a', { startTime: new Date('2026-03-31T23:30:00Z'), finishingPosition: 2 }),
      result('b', { startTime: new Date('2026-04-01T00:00:00Z'), finishingPosition: 9 }),
      result('c', { startTime: new Date('2026-04-20T00:00:00Z'), finishingPosition: 1 }),
    ];
    const { service } = makeService(results, []);
    const { byMonth } = await service.getRecap({ year: 2026, teamId: null });
    expect(byMonth[2]).toEqual({ month: 3, races: 1, podiums: 1 });
    expect(byMonth[3]).toEqual({ month: 4, races: 2, podiums: 1 });
    expect(byMonth.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('builds top lists, the best result and the longest race', async () => {
    const results = [
      result('a', { trackName: 'Spa', trackConfig: 'GP', finishingPosition: 4, startTime: new Date('2026-02-01T10:00:00Z'), endTime: new Date('2026-02-01T12:00:00Z') }),
      result('b', { trackName: 'Spa', trackConfig: 'GP', finishingPosition: 2, startTime: new Date('2026-03-01T10:00:00Z'), endTime: new Date('2026-03-02T10:00:00Z'), seriesName: '24h' }),
      result('c', { trackId: 't2', trackName: 'Monza', carId: null, carName: 'Audi R8', finishingPosition: 6, startTime: new Date('2026-04-01T10:00:00Z'), endTime: null, seriesName: null }),
      result('d', { trackId: null, trackName: 'Imola', carId: null, carName: null, finishingPosition: 1, startTime: new Date('2026-05-01T10:00:00Z'), endTime: null }),
    ];
    const stints = [stint('b', 1, 'Alice', { lapsComplete: 50, averageLapTimeMs: 100_000 })];
    const { service } = makeService(results, stints);
    const recap = await service.getRecap({ year: 2026, teamId: null });
    expect(recap.topTracks[0]).toEqual({ id: 't1', name: 'Spa — GP', races: 2, bestFinish: 2 });
    expect(recap.topTracks.map((t) => t.name)).toEqual(['Spa — GP', 'Imola', 'Monza']);
    expect(recap.topCars[0]).toEqual({ id: 'c1', name: 'BMW M4 GT3', races: 2, bestFinish: 2 });
    expect(recap.topCars.map((c) => c.name)).toEqual(['BMW M4 GT3', 'Audi R8']);
    expect(recap.topSeries).toEqual([
      { name: 'IMSA', races: 2 },
      { name: '24h', races: 1 },
    ]);
    expect(recap.bestResult).toMatchObject({ resultId: 'd', position: 1, trackName: 'Imola', carName: null });
    expect(recap.longestRace).toMatchObject({
      resultId: 'b',
      trackName: 'Spa — GP',
      seriesName: '24h',
      lapsComplete: 50,
      driveMs: 5_000_000,
      durationMs: 86_400_000,
    });
    expect(recap.firsts.firstRace).toEqual({ date: '2026-02-01T10:00:00.000Z', trackName: 'Spa — GP' });
    expect(recap.firsts.lastRace).toEqual({ date: '2026-05-01T10:00:00.000Z', trackName: 'Imola' });
  });

  it('lists every driver sorted by drive time with their own totals', async () => {
    const results = [result('a'), result('b', { startTime: new Date('2026-04-01T10:00:00Z') })];
    const stints = [
      stint('a', 1, 'Alice', { lapsComplete: 10, averageLapTimeMs: 100_000, bestLapTimeMs: 98_000, incidents: 2 }),
      stint('b', 1, 'Alice', { lapsComplete: 20, averageLapTimeMs: 100_000, bestLapTimeMs: 97_000, incidents: 1 }),
      stint('a', 2, 'Bob', { driverProfileId: null, lapsComplete: 40, averageLapTimeMs: 100_000, bestLapTimeMs: null, incidents: null }),
    ];
    const { service } = makeService(results, stints);
    const { drivers } = await service.getRecap({ year: 2026, teamId: null });
    expect(drivers).toEqual([
      { driverProfileId: null, name: 'Bob', races: 1, laps: 40, driveMs: 4_000_000, bestLapMs: null, incidents: 0, stints: 1 },
      { driverProfileId: 'p1', name: 'Alice', races: 2, laps: 30, driveMs: 3_000_000, bestLapMs: 97_000, incidents: 3, stints: 2 },
    ]);
  });

  describe('awards', () => {
    async function awardsFor(stints: FakeStint[]) {
      const ids = [...new Set(stints.map((s) => s.raceResultId))];
      const { service } = makeService(ids.map((id) => result(id)), stints);
      return (await service.getRecap({ year: 2026, teamId: null })).awards;
    }

    it('names the winner of each award with formatted values', async () => {
      const awards = await awardsFor([
        stint('a', 1, 'Alice', { lapsComplete: 300, averageLapTimeMs: 60_000, bestLapTimeMs: 90_500, incidents: 3 }),
        stint('a', 2, 'Bob', { lapsComplete: 250, averageLapTimeMs: 60_000, bestLapTimeMs: 89_250, incidents: 30 }),
        stint('b', 1, 'Alice', { lapsComplete: 10, averageLapTimeMs: 60_000, incidents: 0 }),
      ]);
      const byKey = Object.fromEntries(awards.map((a) => [a.key, a]));
      expect(byKey['iron-driver']).toMatchObject({ driverName: 'Alice', value: '5h 10m', detail: "55% of the team's driving" });
      expect(byKey['lap-leader']).toMatchObject({ driverName: 'Alice', value: '310 laps' });
      expect(byKey['fastest-lap']).toMatchObject({ driverName: 'Bob', value: '1:29.250', detail: 'Spa' });
      expect(byKey['cleanest']).toMatchObject({ driverName: 'Alice', value: '1 per 100 laps', detail: '3 incidents in 310 laps' });
      expect(byKey['most-stints']).toMatchObject({ driverName: 'Alice', value: '2 stints' });
    });

    it('omits everything with a single driver', async () => {
      expect(await awardsFor([stint('a', 1, 'Solo', { lapsComplete: 500 })])).toEqual([]);
    });

    it('omits an award when the top spot is tied', async () => {
      const awards = await awardsFor([
        stint('a', 1, 'Alice', { lapsComplete: 300, averageLapTimeMs: 60_000, bestLapTimeMs: 90_000, incidents: 3 }),
        stint('a', 2, 'Bob', { lapsComplete: 300, averageLapTimeMs: 60_000, bestLapTimeMs: 90_000, incidents: 3 }),
      ]);
      expect(awards).toEqual([]);
    });

    it('cleanest only considers drivers with at least the minimum laps', async () => {
      const awards = await awardsFor([
        stint('a', 1, 'Alice', { lapsComplete: CLEANEST_MIN_LAPS, incidents: 10 }),
        stint('a', 2, 'Bob', { lapsComplete: CLEANEST_MIN_LAPS - 1, incidents: 0 }),
      ]);
      expect(awards.find((a) => a.key === 'cleanest')).toBeUndefined();

      const withTwo = await awardsFor([
        stint('a', 1, 'Alice', { lapsComplete: CLEANEST_MIN_LAPS, incidents: 10 }),
        stint('a', 2, 'Bob', { lapsComplete: CLEANEST_MIN_LAPS + 100, incidents: 10 }),
        stint('a', 3, 'Cara', { lapsComplete: CLEANEST_MIN_LAPS - 1, incidents: 0 }),
      ]);
      expect(withTwo.find((a) => a.key === 'cleanest')).toMatchObject({ driverName: 'Bob' });
    });

    it('fastest lap needs at least two drivers with a lap time', async () => {
      const awards = await awardsFor([
        stint('a', 1, 'Alice', { bestLapTimeMs: 90_000 }),
        stint('a', 2, 'Bob', { bestLapTimeMs: null }),
      ]);
      expect(awards.find((a) => a.key === 'fastest-lap')).toBeUndefined();
    });
  });

  describe('caching', () => {
    it('serves the same (year, team) from memory for 5 minutes, then recomputes', async () => {
      const { service, resultsRepo } = makeService([result('a')], []);
      const first = await service.getRecap({ year: 2026, teamId: null });
      expect(await service.getRecap({ year: 2026, teamId: null })).toBe(first);
      expect(resultsRepo.find).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(RECAP_TTL_MS - 1);
      await service.getRecap({ year: 2026, teamId: null });
      expect(resultsRepo.find).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await service.getRecap({ year: 2026, teamId: null });
      expect(resultsRepo.find).toHaveBeenCalledTimes(2);
    });

    it('caches per year and per absolute team id', async () => {
      const { service, resultsRepo } = makeService([result('a')], []);
      await service.getRecap({ year: 2026, teamId: 100 });
      await service.getRecap({ year: 2026, teamId: -100 }); // same absolute id -> cached
      expect(resultsRepo.find).toHaveBeenCalledTimes(1);
      await service.getRecap({ year: 2025, teamId: 100 });
      await service.getRecap({ year: 2026, teamId: null });
      expect(resultsRepo.find).toHaveBeenCalledTimes(3);
    });

    it('shares one computation between concurrent misses', async () => {
      const { service, resultsRepo } = makeService([result('a')], []);
      await Promise.all([service.getRecap({ year: 2026, teamId: null }), service.getRecap({ year: 2026, teamId: null })]);
      expect(resultsRepo.find).toHaveBeenCalledTimes(1);
    });
  });
});
