import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { IracingCarUsageService } from './iracing-car-usage.service.js';

function makeService(row: unknown) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['select', 'addSelect', 'where', 'andWhere']) {
    qb[name] = vi.fn().mockReturnValue(qb);
  }
  qb.getRawOne = vi.fn().mockResolvedValue(row);
  const statsRepository = { createQueryBuilder: vi.fn().mockReturnValue(qb) };
  const stub = {} as never;
  const service = new IracingCarUsageService(stub, statsRepository as never, stub, stub, stub);
  return { service, qb };
}

describe('IracingCarUsageService.getEntriesScanned', () => {
  it('returns the summed entry count and distinct car count for the week', async () => {
    const { service, qb } = makeService({ entries: '2184', cars: '23' });

    await expect(service.getEntriesScanned(5555, 4)).resolves.toEqual({
      seasonId: 5555,
      raceWeekNum: 4,
      entriesScanned: 2184,
      carCount: 23,
    });
    expect(qb.where).toHaveBeenCalledWith('s.seasonId = :seasonId', { seasonId: 5555 });
    expect(qb.andWhere).toHaveBeenCalledWith('s.raceWeekNum = :raceWeekNum', { raceWeekNum: 4 });
  });

  it('is zero when nothing has been scanned', async () => {
    const { service } = makeService({ entries: '0', cars: '0' });
    await expect(service.getEntriesScanned(1, 0)).resolves.toMatchObject({ entriesScanned: 0, carCount: 0 });
    const { service: empty } = makeService(undefined);
    await expect(empty.getEntriesScanned(1, 0)).resolves.toMatchObject({ entriesScanned: 0, carCount: 0 });
  });
});

function makeScanService(options: { scanned?: number[]; fetch?: ReturnType<typeof vi.fn>; insert?: ReturnType<typeof vi.fn> }) {
  const manager = {
    insert: options.insert ?? vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue(undefined),
  };
  const statsRepository = {
    manager: { transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)) },
  };
  const scannedRepository = {
    find: vi.fn().mockResolvedValue((options.scanned ?? []).map((subsessionId) => ({ subsessionId }))),
    findOne: vi.fn(),
  };
  const iracingService = {
    fetchCarUsageForSubsession:
      options.fetch ?? vi.fn().mockResolvedValue([{ carId: 1, carName: 'Car A', carClass: 'GT3' }]),
  };
  const stub = {} as never;
  const service = new IracingCarUsageService(
    stub,
    statsRepository as never,
    scannedRepository as never,
    iracingService as never,
    stub,
  );
  return { service, manager, statsRepository, scannedRepository, iracingService };
}

describe('IracingCarUsageService.scanSubsessions', () => {
  it('looks up already-scanned subsessions once for the batch and skips them', async () => {
    const { service, scannedRepository, iracingService, manager } = makeScanService({ scanned: [10] });

    const counted = await service['scanSubsessions'](1, 2, [10, 11, 12], 'token');

    expect(counted).toBe(2);
    expect(scannedRepository.find).toHaveBeenCalledTimes(1);
    expect(scannedRepository.findOne).not.toHaveBeenCalled();
    expect(iracingService.fetchCarUsageForSubsession).toHaveBeenCalledTimes(2);
    expect(iracingService.fetchCarUsageForSubsession).not.toHaveBeenCalledWith('token', 10);
    expect(manager.insert).toHaveBeenCalledTimes(2);
  });

  it('adds counts with one atomic upsert per subsession, folding duplicate cars', async () => {
    const fetch = vi.fn().mockResolvedValue([
      { carId: 1, carName: 'Car A', carClass: 'GT3' },
      { carId: 2, carName: 'Car B', carClass: 'GT4' },
      { carId: 1, carName: 'Car A', carClass: 'GT3' },
    ]);
    const { service, manager } = makeScanService({ fetch });

    await service['scanSubsessions'](7, 3, [100], 'token');

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (season_id, race_week_num, car_id) DO UPDATE');
    expect(sql).toContain('entry_count = iracing_car_usage_stats.entry_count + EXCLUDED.entry_count');
    expect(params).toHaveLength(14); // 2 distinct cars x 7 columns
    // [id, season, week, car, name, class, count]
    expect(params.slice(1, 7)).toEqual([7, 3, 1, 'Car A', 'GT3', 2]);
    expect(params.slice(8, 14)).toEqual([7, 3, 2, 'Car B', 'GT4', 1]);
  });

  it('does not mark a subsession scanned while the race has no results yet', async () => {
    const { service, manager } = makeScanService({ fetch: vi.fn().mockResolvedValue([]) });
    await expect(service['scanSubsessions'](1, 1, [5], 'token')).resolves.toBe(0);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('counts nothing when a concurrent scan already recorded the subsession (unique violation)', async () => {
    const violation = Object.assign(Object.create(QueryFailedError.prototype), {
      driverError: { code: '23505' },
      message: 'duplicate key',
    });
    const { service, manager } = makeScanService({ insert: vi.fn().mockRejectedValue(violation) });

    await expect(service['scanSubsessions'](1, 1, [5], 'token')).resolves.toBe(0);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('logs and carries on past other failures', async () => {
    const insert = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const { service } = makeScanService({ insert });
    await expect(service['scanSubsessions'](1, 1, [5, 6], 'token')).resolves.toBe(1);
  });
});

describe('IracingCarUsageService.runExclusive', () => {
  it('skips a second task while one is running and frees the lock afterwards (even on error)', async () => {
    const { service } = makeScanService({});
    let release!: () => void;
    const first = service.runExclusive(() => new Promise<string>((resolve) => (release = () => resolve('done'))));
    const task = vi.fn().mockResolvedValue('second');

    await expect(service.runExclusive(task)).resolves.toEqual({ ran: false });
    expect(task).not.toHaveBeenCalled();

    release();
    await expect(first).resolves.toEqual({ ran: true, value: 'done' });
    await expect(service.runExclusive(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(service.runExclusive(task)).resolves.toEqual({ ran: true, value: 'second' });
  });

  it('scanSince refuses to start while another scan is running', async () => {
    const { service } = makeScanService({});
    let release!: () => void;
    const running = service.runExclusive(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(service.scanSince(1, new Date(), 'admin')).rejects.toThrow(/already running/);
    release();
    await running;
  });
});
