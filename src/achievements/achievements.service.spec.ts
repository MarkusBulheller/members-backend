import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AchievementMetric } from '../common/enums/achievement-metric.enum.js';
import { AchievementsService } from './achievements.service.js';

function makeService(opts: {
  definitions?: Array<Record<string, unknown>>;
  holderRows?: Array<{ definitionId: string; holders: string }>;
}) {
  const definitionsRepository = { find: vi.fn().mockResolvedValue(opts.definitions ?? []) };
  const builder = {
    innerJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    getRawMany: vi.fn().mockResolvedValue(opts.holderRows ?? []),
  };
  const awardsRepository = { createQueryBuilder: vi.fn().mockReturnValue(builder) };
  const stub = {} as never;
  const service = new AchievementsService(
    definitionsRepository as never,
    stub,
    awardsRepository as never,
    stub,
    stub,
  );
  return { service, definitionsRepository, awardsRepository, builder };
}

describe('AchievementsService.listDefinitions', () => {
  it('adds a holderCount per definition from one grouped query (0 when nobody holds it)', async () => {
    const { service, awardsRepository } = makeService({
      definitions: [
        { id: 'd1', name: 'Century Club', tiers: [] },
        { id: 'd2', name: 'Race Winner', tiers: [] },
      ],
      holderRows: [{ definitionId: 'd1', holders: '11' }],
    });

    const list = await service.listDefinitions();

    expect(list.map((d) => [d.id, d.holderCount])).toEqual([
      ['d1', 11],
      ['d2', 0],
    ]);
    expect(awardsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});

describe('AchievementsService.recalculateAll', () => {
  const defs = [
    { id: 'a', name: 'Alpha', metric: AchievementMetric.LAPS },
    { id: 'm', name: 'Manual one', metric: AchievementMetric.MANUAL },
    { id: 'b', name: 'Bravo', metric: AchievementMetric.WINS },
    { id: 'c', name: 'Charlie', metric: AchievementMetric.PODIUMS },
  ];

  it('recalculates each non-MANUAL definition in order, summing awards and collecting failures', async () => {
    const { service } = makeService({ definitions: defs });
    const order: string[] = [];
    vi.spyOn(service, 'recalculate').mockImplementation(async (id: string) => {
      order.push(id);
      if (id === 'b') throw new Error('boom');
      return { newAwards: id === 'a' ? 3 : 2 };
    });

    const result = await service.recalculateAll();

    expect(order).toEqual(['a', 'b', 'c']);
    expect(result.definitionsProcessed).toBe(2);
    expect(result.newAwards).toBe(5);
    expect(result.results).toEqual([
      { id: 'a', name: 'Alpha', newAwards: 3 },
      { id: 'c', name: 'Charlie', newAwards: 2 },
    ]);
    expect(result.failures).toEqual([{ id: 'b', name: 'Bravo', message: 'boom' }]);
  });

  it('runs one definition at a time', async () => {
    const { service } = makeService({ definitions: defs });
    let running = 0;
    let maxRunning = 0;
    vi.spyOn(service, 'recalculate').mockImplementation(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return { newAwards: 0 };
    });

    await service.recalculateAll();

    expect(maxRunning).toBe(1);
  });

  it('rejects an overlapping run and allows a new one once the first finishes', async () => {
    const { service } = makeService({ definitions: defs });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(service, 'recalculate').mockImplementation(async () => {
      await gate;
      return { newAwards: 0 };
    });

    const first = service.recalculateAll();
    await expect(service.recalculateAll()).rejects.toBeInstanceOf(ConflictException);

    release();
    await first;
    await expect(service.recalculateAll()).resolves.toMatchObject({ definitionsProcessed: 3 });
  });

  it('returns an empty result when there is nothing to recalculate', async () => {
    const { service } = makeService({ definitions: [{ id: 'm', name: 'Manual', metric: AchievementMetric.MANUAL }] });

    expect(await service.recalculateAll()).toEqual({ definitionsProcessed: 0, newAwards: 0, results: [], failures: [] });
  });
});
