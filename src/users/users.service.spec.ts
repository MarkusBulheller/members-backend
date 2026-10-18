import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';

function makeService(rows: Array<{ status: string; count: string }>) {
  const getRawMany = vi.fn().mockResolvedValue(rows);
  const builder = {
    select: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    getRawMany,
  };
  const usersRepository = { createQueryBuilder: vi.fn().mockReturnValue(builder) };
  return { service: new UsersService(usersRepository as never), builder };
}

describe('UsersService.countByStatus', () => {
  it('returns every status (0 when absent) plus the total, using one grouped query', async () => {
    const { service, builder } = makeService([
      { status: 'PENDING', count: '2' },
      { status: 'APPROVED', count: '11' },
      { status: 'REJECTED', count: '1' },
    ]);

    const counts = await service.countByStatus();

    expect(counts).toEqual({ PENDING: 2, APPROVED: 11, SUSPENDED: 0, REJECTED: 1, ALL: 14 });
    expect(builder.groupBy).toHaveBeenCalledTimes(1);
  });

  it('returns all zeros when there are no users', async () => {
    const { service } = makeService([]);

    expect(await service.countByStatus()).toEqual({ PENDING: 0, APPROVED: 0, SUSPENDED: 0, REJECTED: 0, ALL: 0 });
  });

  it('ignores unknown status values rather than corrupting the total', async () => {
    const { service } = makeService([
      { status: 'PENDING', count: '3' },
      { status: 'WEIRD', count: '9' },
    ]);

    const counts = await service.countByStatus();

    expect(counts.PENDING).toBe(3);
    expect(counts.ALL).toBe(3);
  });
});
