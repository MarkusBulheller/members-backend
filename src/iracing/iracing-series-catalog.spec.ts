import { BadGatewayException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IracingService } from './iracing.service.js';
import { IracingSeriesService } from './iracing-series.service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const gatewayTimeout = () => new Response('<html>504</html>', { status: 504 });

function makeIracing() {
  const service = new IracingService({ get: vi.fn() } as never);
  const tunable = service as unknown as { retryDelayMs: number; seriesSyncPauseMs: number };
  tunable.retryDelayMs = 0;
  tunable.seriesSyncPauseMs = 0;
  vi.spyOn(service as unknown as { exchangeCodeForToken: () => Promise<unknown> }, 'exchangeCodeForToken').mockResolvedValue({
    accessToken: 'token',
    refreshToken: null,
  });
  return service;
}

/** season_list with `count` official seasons (season id == series id == index + 1). */
function seasonList(count: number) {
  return {
    seasons: Array.from({ length: count }, (_, i) => ({
      season_id: i + 1,
      series_id: i + 1,
      series_name: `Series ${i + 1}`,
      season_name: 'S',
      official: true,
    })),
  };
}

describe('IracingService.exchangeCodeForSeriesCatalog', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function route(scheduleFor: (seasonId: number) => Response, count: number) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/series/season_list')) return jsonResponse(seasonList(count));
      if (url.endsWith('/series/assets')) return jsonResponse({});
      const match = /season_id=(\d+)/.exec(url);
      if (match) return scheduleFor(Number(match[1]));
      throw new Error(`unexpected ${url}`);
    });
  }

  it('retries a transient 504 and still gets the season', async () => {
    const attempts: Record<number, number> = {};
    route((id) => {
      attempts[id] = (attempts[id] ?? 0) + 1;
      return id === 2 && attempts[id] < 2 ? gatewayTimeout() : jsonResponse({ schedules: [{ race_week_num: 0 }] });
    }, 3);

    const { seasons, failedSeriesIds } = await makeIracing().exchangeCodeForSeriesCatalog('c', 'v');

    expect(seasons.map((s) => s.seasonId).sort()).toEqual([1, 2, 3]);
    expect(failedSeriesIds).toEqual([]);
    expect(attempts[2]).toBe(2);
  });

  it('reports a season that keeps failing instead of silently dropping it', async () => {
    route((id) => (id === 2 ? gatewayTimeout() : jsonResponse({ schedules: [] })), 3);

    const { seasons, failedSeriesIds } = await makeIracing().exchangeCodeForSeriesCatalog('c', 'v');

    expect(seasons.map((s) => s.seasonId).sort()).toEqual([1, 3]);
    expect(failedSeriesIds).toEqual([2]);
  });

  it('treats a request that never answers (timeout) like a failure', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/series/season_list')) return jsonResponse(seasonList(1));
      if (url.endsWith('/series/assets')) return jsonResponse({});
      throw new DOMException('timed out', 'TimeoutError');
    });

    const { seasons, failedSeriesIds } = await makeIracing().exchangeCodeForSeriesCatalog('c', 'v');

    expect(seasons).toEqual([]);
    expect(failedSeriesIds).toEqual([1]);
  });

  it('gives up early when iRacing is down for ten seasons in a row', async () => {
    route(() => gatewayTimeout(), 60);

    await expect(makeIracing().exchangeCodeForSeriesCatalog('c', 'v')).rejects.toBeInstanceOf(BadGatewayException);

    // 2 catalog calls + roughly ten seasons (plus the few already in flight) x 2 attempts, nowhere
    // near all 60 seasons.
    expect(fetchMock.mock.calls.length).toBeLessThan(2 + 20 * 2 + 10);
  });

  it('a persistently failing season does not stall the others or abort the sync', async () => {
    route((id) => (id % 7 === 0 ? gatewayTimeout() : jsonResponse({ schedules: [] })), 40);

    const { seasons, failedSeriesIds } = await makeIracing().exchangeCodeForSeriesCatalog('c', 'v');

    expect(failedSeriesIds.sort((a, b) => a - b)).toEqual([7, 14, 21, 28, 35]);
    expect(seasons).toHaveLength(35);
  });

  it('stops fetching once the time budget is spent instead of hanging on', async () => {
    route(() => jsonResponse({ schedules: [] }), 12);
    const service = makeIracing();
    (service as unknown as { seriesSyncBudgetMs: number }).seriesSyncBudgetMs = -1;

    // Past the deadline every remaining season counts as not refreshed; with nothing refreshed at
    // all that reads as "iRacing isn't answering", and no schedule request is even made.
    await expect(service.exchangeCodeForSeriesCatalog('c', 'v')).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('does not retry a client error (4xx)', async () => {
    const attempts: Record<number, number> = {};
    route((id) => {
      attempts[id] = (attempts[id] ?? 0) + 1;
      return new Response('nope', { status: 404 });
    }, 1);

    const { failedSeriesIds } = await makeIracing().exchangeCodeForSeriesCatalog('c', 'v');

    expect(attempts[1]).toBe(1);
    expect(failedSeriesIds).toEqual([1]);
  });
});

describe('IracingSeriesService.sync', () => {
  function makeSeries(input: { seasons: Record<string, unknown>[]; failedSeriesIds: number[] }, storedNames: Record<number, string> = {}) {
    const catalog = {
      ...input,
      failedSeries: input.failedSeriesIds.map((seriesId) => ({ seriesId, seasonId: seriesId * 10, name: `Season name ${seriesId}` })),
    };
    const update = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), execute: vi.fn() };
    const repository = {
      find: vi.fn().mockImplementation(async (options: { where: { trackCarUsage?: boolean } }) =>
        options.where.trackCarUsage ? [{ seriesId: 1 }] : Object.entries(storedNames).map(([id, seriesName]) => ({ seriesId: Number(id), seriesName })),
      ),
      create: vi.fn((v: unknown) => v),
      save: vi.fn().mockResolvedValue(undefined),
      createQueryBuilder: vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue(update) }),
    };
    const iracing = { exchangeCodeForSeriesCatalog: vi.fn().mockResolvedValue(catalog) };
    const service = new IracingSeriesService(repository as never, iracing as never, { get: vi.fn() } as never);
    return { service, repository, update };
  }

  it('archives only the series it heard back about, never one whose fetch failed', async () => {
    const { service, update } = makeSeries({
      seasons: [
        { seasonId: 11, seriesId: 1 },
        { seasonId: 22, seriesId: 2 },
      ],
      failedSeriesIds: [2],
    });

    const result = await service.sync('c', 'v');

    expect(result).toEqual({ synced: 2, failed: 1, failedSeries: [{ seriesId: 2, name: 'Season name 2' }] });
    expect(update.where).toHaveBeenCalledWith('series_id IN (:...seriesIds)', { seriesIds: [1] });
  });

  it('names a failed series by the series name already stored, sorted by name', async () => {
    const { service } = makeSeries({ seasons: [], failedSeriesIds: [2, 3] }, { 2: 'Zeta Cup', 3: 'Alpha Cup' });

    const result = await service.sync('c', 'v');

    expect(result.failedSeries).toEqual([
      { seriesId: 3, name: 'Alpha Cup' },
      { seriesId: 2, name: 'Zeta Cup' },
    ]);
  });

  it('keeps the car-usage opt-in on a series that has a sibling season that failed', async () => {
    const { service, repository } = makeSeries({ seasons: [{ seasonId: 11, seriesId: 1 }], failedSeriesIds: [1] });

    await service.sync('c', 'v');

    const saved = repository.save.mock.calls[0][0] as { trackCarUsage: boolean }[];
    expect(saved[0].trackCarUsage).toBe(true);
  });

  it('archives nothing when every series failed', async () => {
    const { service, repository } = makeSeries({ seasons: [], failedSeriesIds: [1, 2] });

    await service.sync('c', 'v');

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
