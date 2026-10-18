import { describe, expect, it, vi } from 'vitest';
import { IracingCarUsageSyncService } from './iracing-car-usage-sync.service.js';

function makeSync(runExclusive: ReturnType<typeof vi.fn>) {
  const carUsage = {
    runExclusive,
    listTrackedSeasons: vi.fn().mockResolvedValue([{ seasonId: 1 }, { seasonId: 2 }]),
    scanSeason: vi.fn().mockResolvedValue(undefined),
  };
  const adminToken = { getSystemAccessToken: vi.fn().mockResolvedValue('tok') };
  return { service: new IracingCarUsageSyncService(carUsage as never, adminToken as never), carUsage };
}

describe('IracingCarUsageSyncService.scanAll', () => {
  it('runs the scan under the exclusivity guard and scans every tracked season', async () => {
    const { service, carUsage } = makeSync(vi.fn(async (task: () => Promise<unknown>) => ({ ran: true, value: await task() })));
    await service.scanAll();
    expect(carUsage.scanSeason).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the previous run is still going', async () => {
    const { service, carUsage } = makeSync(vi.fn().mockResolvedValue({ ran: false }));
    await service.scanAll();
    expect(carUsage.listTrackedSeasons).not.toHaveBeenCalled();
    expect(carUsage.scanSeason).not.toHaveBeenCalled();
  });
});
