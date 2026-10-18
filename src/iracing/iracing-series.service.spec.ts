import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IracingSeriesService } from './iracing-series.service.js';

function makeService(rows: Record<string, unknown>[] = []) {
  const repository = {
    find: vi.fn().mockResolvedValue(rows),
    findOne: vi.fn().mockResolvedValue(rows[0] ?? null),
  };
  const config = { get: vi.fn().mockReturnValue('https://img.example') };
  const service = new IracingSeriesService(repository as never, {} as never, config as never);
  return { service, repository };
}

describe('IracingSeriesService.list', () => {
  it('selects every column except the heavy schedule and resolves the logo url', async () => {
    const { service, repository } = makeService([{ seasonId: 1, seriesName: 'A', logo: 'seriesid_1.png' }]);

    const result = await service.list();

    const options = repository.find.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(options.select).toBeDefined();
    expect(options.select.schedule).toBeUndefined();
    expect(options.select).toMatchObject({ seasonId: true, seriesName: true, logo: true, trackCarUsage: true });
    expect(result[0]).not.toHaveProperty('schedule');
    expect(result[0].logoUrl).toBe('https://img.example/img/logos/series/seriesid_1.png');
  });

  it('gives a null logoUrl for seasons without a logo', async () => {
    const { service } = makeService([{ seasonId: 2, seriesName: 'B', logo: null }]);
    expect((await service.list())[0].logoUrl).toBeNull();
  });
});

describe('IracingSeriesService.getById', () => {
  it('returns the full season including its schedule', async () => {
    const schedule = [{ race_week_num: 0 }];
    const { service, repository } = makeService([{ seasonId: 7, logo: null, schedule }]);

    const season = await service.getById(7);

    expect(repository.findOne).toHaveBeenCalledWith({ where: { seasonId: 7 } });
    expect(season.schedule).toBe(schedule);
    expect(season.logoUrl).toBeNull();
  });

  it('throws NotFound for an unknown season', async () => {
    const { service } = makeService([]);
    await expect(service.getById(99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
