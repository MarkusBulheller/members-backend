import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamHighlight } from './team-highlight.entity.js';
import { TeamHighlightsService } from './team-highlights.service.js';

function highlight(overrides: Partial<TeamHighlight> = {}): TeamHighlight {
  return {
    id: 'h1',
    period: 'Nov 2025',
    title: 'Class win at Daytona',
    description: 'Won the class',
    position: null,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(rows: TeamHighlight[] = []) {
  const repository = {
    find: vi.fn().mockImplementation(async () => [...rows].sort((a, b) => a.order - b.order)),
    findOne: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
    ),
    maximum: vi.fn().mockResolvedValue(rows.length ? Math.max(...rows.map((r) => r.order)) : null),
    create: vi.fn().mockImplementation((data: Partial<TeamHighlight>) => ({ ...data })),
    save: vi.fn().mockImplementation(async (value: unknown) => value),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new TeamHighlightsService(repository as never), repository };
}

describe('TeamHighlightsService position badge', () => {
  let rows: TeamHighlight[];
  beforeEach(() => {
    rows = [highlight({ id: 'h1', order: 0, position: 1 }), highlight({ id: 'h2', order: 1, position: null })];
  });

  it('stores the position on create and appends to the end of the timeline', async () => {
    const { service, repository } = makeService(rows);
    await service.create({ period: 'Oct 2025', title: 'Podium', description: 'P2', position: 2 });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ position: 2, order: 2 }));
  });

  it('defaults the position to null when omitted or null on create', async () => {
    const { service, repository } = makeService(rows);
    await service.create({ period: 'p', title: 't', description: 'd' });
    await service.create({ period: 'p', title: 't', description: 'd', position: null });
    expect(repository.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ position: null }));
    expect(repository.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ position: null }));
  });

  it('starts ordering at 0 on an empty timeline', async () => {
    const { service, repository } = makeService([]);
    await service.create({ period: 'p', title: 't', description: 'd' });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ order: 0 }));
  });

  it('updates the position, leaves it alone when undefined, and clears it on null', async () => {
    const { service } = makeService(rows);

    const set = await service.update('h2', { position: 6 });
    expect(set.position).toBe(6);

    const untouched = await service.update('h1', { title: 'Renamed' });
    expect(untouched.title).toBe('Renamed');
    expect(untouched.position).toBe(1);

    const cleared = await service.update('h1', { position: null });
    expect(cleared.position).toBeNull();
  });

  it('throws NotFound when updating an unknown highlight', async () => {
    const { service } = makeService(rows);
    await expect(service.update('nope', { position: 3 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('swaps order with the neighbour on move and is a no-op at the ends', async () => {
    const { service, repository } = makeService(rows);
    await service.move('h2', 'up');
    expect(rows.find((r) => r.id === 'h1')?.order).toBe(1);
    expect(rows.find((r) => r.id === 'h2')?.order).toBe(0);

    repository.save.mockClear();
    await service.move('h2', 'up'); // h2 is now first
    expect(repository.save).not.toHaveBeenCalled();
  });
});
