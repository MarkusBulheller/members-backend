import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_TTL_MS, PUBLIC_SUMMARY_TTL_MS, StatsService } from './stats.service.js';

const NO_FILTERS = { year: null, trackId: null, carId: null, series: null, raceLength: null };

function stint(raceResultId: string, iracingCustId: number, displayName: string, lapsComplete: number, incidents: number) {
  return { id: `${raceResultId}-${iracingCustId}`, iracingCustId, driverProfileId: `p${iracingCustId}`, displayName, lapsComplete, incidents };
}

const RESULTS = [
  {
    id: 'r1',
    trackId: 't1',
    trackName: 'Spa',
    trackConfig: 'GP',
    carId: 'c1',
    carName: 'BMW M4 GT3',
    seriesName: 'IMSA',
    startTime: new Date('2026-03-01T10:00:00Z'),
    endTime: new Date('2026-03-01T14:00:00Z'), // 4h
    finishingPosition: 5,
    finishingPositionInClass: 1,
    driverStints: [stint('r1', 1, 'Alice', 100, 10), stint('r1', 2, 'Bob', 10, 0)],
  },
  {
    id: 'r2',
    trackId: 't2',
    trackName: 'Monza',
    trackConfig: null,
    carId: 'c1',
    carName: 'BMW M4 GT3',
    seriesName: 'GT Endurance',
    startTime: new Date('2025-06-15T10:00:00Z'),
    endTime: new Date('2025-06-15T16:00:00Z'), // 6h
    finishingPosition: 2,
    finishingPositionInClass: null,
    driverStints: [stint('r2', 1, 'Alice', 50, 5)],
  },
  {
    id: 'r3',
    trackId: null,
    trackName: 'Imola',
    trackConfig: null,
    carId: null,
    carName: null,
    seriesName: null,
    startTime: null,
    endTime: null,
    finishingPosition: null,
    finishingPositionInClass: null,
    driverStints: [],
  },
];

function makeService(rawRow?: Record<string, string>) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['select', 'addSelect']) qb[name] = vi.fn().mockReturnValue(qb);
  qb.getRawOne = vi.fn().mockResolvedValue(rawRow);
  const repo = { find: vi.fn().mockResolvedValue(RESULTS), createQueryBuilder: vi.fn().mockReturnValue(qb) };
  return { service: new StatsService(repo as never), repo, qb };
}

describe('StatsService.getPublicSummary', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('maps the SQL aggregate to the same response shape (hours rounded from seconds)', async () => {
    // 4h + 6h = 36000s -> 10 hours; matches the JS loop it replaced for RESULTS (r3 has no times/position).
    const { service, repo } = makeService({ races: '3', wins: '1', podiums: '2', seconds: '36000.5' });
    await expect(service.getPublicSummary()).resolves.toEqual({
      raceWins: 1,
      podiumFinishes: 2,
      hoursRaced: 10,
      racesEntered: 3,
    });
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('is all zeroes when there are no results', async () => {
    const { service } = makeService(undefined);
    await expect(service.getPublicSummary()).resolves.toEqual({
      raceWins: 0,
      podiumFinishes: 0,
      hoursRaced: 0,
      racesEntered: 0,
    });
  });

  it('serves repeat hits from the cache until the TTL expires, and shares concurrent misses', async () => {
    const { service, qb } = makeService({ races: '1', wins: '0', podiums: '0', seconds: '0' });
    await Promise.all([service.getPublicSummary(), service.getPublicSummary()]);
    await service.getPublicSummary();
    expect(qb.getRawOne).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PUBLIC_SUMMARY_TTL_MS + 1);
    await service.getPublicSummary();
    expect(qb.getRawOne).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed computation', async () => {
    const { service, qb } = makeService({ races: '1', wins: '0', podiums: '0', seconds: '0' });
    qb.getRawOne.mockRejectedValueOnce(new Error('db down'));
    await expect(service.getPublicSummary()).rejects.toThrow('db down');
    await expect(service.getPublicSummary()).resolves.toMatchObject({ racesEntered: 1 });
  });
});

describe('StatsService.getDashboard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aggregates leaderboards, results and filter options for sample data', async () => {
    const { service } = makeService();
    const dashboard = await service.getDashboard(NO_FILTERS);

    expect(dashboard.mostEvents).toEqual([
      { iracingCustId: 1, driverProfileId: 'p1', name: 'Alice', value: 2 },
      { iracingCustId: 2, driverProfileId: 'p2', name: 'Bob', value: 1 },
    ]);
    expect(dashboard.mostLaps).toEqual([
      { iracingCustId: 1, driverProfileId: 'p1', name: 'Alice', value: 150 },
      { iracingCustId: 2, driverProfileId: 'p2', name: 'Bob', value: 10 },
    ]);
    // Bob has < 20 laps so is not eligible; Alice: 15 incidents / 150 laps.
    expect(dashboard.leastIncidentsPerLap).toEqual([
      { iracingCustId: 1, driverProfileId: 'p1', name: 'Alice', value: 0.1 },
    ]);
    expect(dashboard.mostDrivenTracks).toHaveLength(3);
    expect(dashboard.mostDrivenTracks).toContainEqual({ id: 't1', name: 'Spa — GP', count: 1 });
    expect(dashboard.mostDrivenCars).toEqual([{ id: 'c1', name: 'BMW M4 GT3', count: 2 }]);
    expect(dashboard.results).toEqual([
      { id: 'r3', date: null, position: null, trackName: 'Imola', carName: null },
      { id: 'r2', date: '2025-06-15T10:00:00.000Z', position: 2, trackName: 'Monza', carName: 'BMW M4 GT3' },
      { id: 'r1', date: '2026-03-01T10:00:00.000Z', position: 1, trackName: 'Spa — GP', carName: 'BMW M4 GT3' },
    ]);
    expect(dashboard.filterOptions).toEqual({
      years: [2026, 2025],
      tracks: [
        { id: null, name: 'Imola' },
        { id: 't2', name: 'Monza' },
        { id: 't1', name: 'Spa — GP' },
      ],
      cars: [{ id: 'c1', name: 'BMW M4 GT3' }],
      series: ['GT Endurance', 'IMSA'],
      raceLengths: ['4h 0m', '6h 0m'],
    });
  });

  it('applies filters', async () => {
    const { service } = makeService();
    const byYear = await service.getDashboard({ ...NO_FILTERS, year: 2026 });
    expect(byYear.results.map((r) => r.id)).toEqual(['r1']);
    // Filter options always come from the unfiltered data.
    expect(byYear.filterOptions.years).toEqual([2026, 2025]);
    const byLength = await service.getDashboard({ ...NO_FILTERS, raceLength: '6h 0m' });
    expect(byLength.results.map((r) => r.id)).toEqual(['r2']);
    expect(byLength.mostEvents).toEqual([{ iracingCustId: 1, driverProfileId: 'p1', name: 'Alice', value: 1 }]);
  });

  it('caches per filter combination for the TTL', async () => {
    const { service, repo } = makeService();
    await Promise.all([service.getDashboard(NO_FILTERS), service.getDashboard(NO_FILTERS)]);
    await service.getDashboard(NO_FILTERS);
    expect(repo.find).toHaveBeenCalledTimes(1);

    await service.getDashboard({ ...NO_FILTERS, series: 'IMSA' });
    expect(repo.find).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(DASHBOARD_TTL_MS + 1);
    await service.getDashboard(NO_FILTERS);
    expect(repo.find).toHaveBeenCalledTimes(3);
  });
});
