import { describe, expect, it, vi } from 'vitest';
import { RaceResultsService } from './race-results.service.js';

const data = {
  subsessionId: 11,
  teamId: 100,
  seriesName: 'IMSA',
  trackName: 'Daytona',
  trackConfig: null,
  trackId: null,
  carName: 'BMW M4 GT3',
  carId: null,
  carClassName: 'GT3 Class',
  startTime: '2026-10-24T12:00:00Z',
  endTime: '2026-10-24T14:00:00Z',
  startingPosition: 3,
  finishingPosition: 2,
  startingPositionInClass: 2,
  finishingPositionInClass: 1,
  teamLapsComplete: 80,
  totalLaps: 82,
  teamIncidents: 4,
  splitNumber: null,
  totalSplits: null,
  drivers: [],
  laps: [],
};

function makeService(notifyImported: unknown) {
  const loaded = { id: 'new-result', driverStints: [{ driverProfileId: 'p1' }], laps: [], teamId: 100 };
  const raceResultsRepository = {
    findOne: vi.fn(async (options: { where: { id?: string } }) => (options.where.id ? loaded : null)),
    create: vi.fn((row: Record<string, unknown>) => ({ ...row })),
    save: vi.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'new-result' })),
  };
  const stub = { save: vi.fn(), create: vi.fn((row: unknown) => row) };
  const service = new RaceResultsService(
    raceResultsRepository as never,
    stub as never,
    stub as never,
    { findOne: vi.fn().mockResolvedValue(null) } as never,
    { lookupAsAdmin: vi.fn().mockResolvedValue(data), lookupWithToken: vi.fn().mockResolvedValue(data) } as never,
    {} as never,
    { ensureExists: vi.fn().mockResolvedValue({ id: 'car1' }) } as never,
    { ensureExists: vi.fn().mockResolvedValue({ id: 'track1' }) } as never,
    {} as never,
    {} as never,
    { linkAndComplete: vi.fn().mockResolvedValue(undefined) } as never,
    { notifyImported } as never,
  );
  return { service, loaded };
}

describe('RaceResultsService import -> race summary DMs', () => {
  it('fires the DM service with the loaded result after a manual import, without awaiting it', async () => {
    let release: () => void = () => undefined;
    const notifyImported = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { service, loaded } = makeService(notifyImported);
    // Resolves even though the DMs are still "in flight" - the import never waits for Discord.
    const result = await service.importFromIracing('admin-1', 11, 100);
    expect(result.id).toBe('new-result');
    expect(notifyImported).toHaveBeenCalledTimes(1);
    expect(notifyImported).toHaveBeenCalledWith(expect.objectContaining({ id: loaded.id, driverStints: loaded.driverStints }));
    release();
  });

  it('also fires for the auto-import flow', async () => {
    const notifyImported = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService(notifyImported);
    await service.importWithOptions(11, 100, { source: 'AUTO', accessToken: 'tok' });
    expect(notifyImported).toHaveBeenCalledTimes(1);
  });

  it('a rejecting or throwing DM service never fails the import', async () => {
    const rejecting = makeService(vi.fn().mockRejectedValue(new Error('discord down')));
    await expect(rejecting.service.importFromIracing('admin-1', 11, 100)).resolves.toMatchObject({ id: 'new-result' });
    const throwing = makeService(
      vi.fn(() => {
        throw new Error('sync boom');
      }),
    );
    await expect(throwing.service.importFromIracing('admin-1', 11, 100)).resolves.toMatchObject({ id: 'new-result' });
    // Let the swallowed rejection settle; an unhandled one would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
