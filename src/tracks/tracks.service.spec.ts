import { describe, expect, it, vi } from 'vitest';
import { TracksService } from './tracks.service.js';

function makeService(tracks: unknown[], rows: unknown[]) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
    qb[name] = vi.fn().mockReturnValue(qb);
  }
  qb.getRawMany = vi.fn().mockResolvedValue(rows);
  const tracksRepository = {
    find: vi.fn().mockResolvedValue(tracks),
    findOne: vi.fn().mockResolvedValue(tracks[0]),
    save: vi.fn().mockImplementation(async (t) => t),
  };
  const raceResultsRepository = { createQueryBuilder: vi.fn().mockReturnValue(qb) };
  const service = new TracksService(tracksRepository as never, raceResultsRepository as never);
  return { service, tracksRepository, raceResultsRepository, qb };
}

describe('TracksService.findAll', () => {
  it('adds raceCount and lastRacedAt from one grouped query', async () => {
    const { service, raceResultsRepository } = makeService(
      [{ id: 't1' }, { id: 't2' }],
      [{ trackId: 't1', count: '10', lastRacedAt: new Date('2025-10-04T18:00:00Z') }],
    );

    const tracks = await service.findAll(false);

    expect(tracks[0]).toMatchObject({ id: 't1', raceCount: 10, lastRacedAt: '2025-10-04T18:00:00.000Z' });
    expect(tracks[1]).toMatchObject({ id: 't2', raceCount: 0, lastRacedAt: null });
    expect(raceResultsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it('accepts a date string from the driver and a null start time', async () => {
    const { service } = makeService(
      [{ id: 't1' }, { id: 't2' }],
      [
        { trackId: 't1', count: '2', lastRacedAt: '2025-01-02T03:04:05.000Z' },
        { trackId: 't2', count: '1', lastRacedAt: null },
      ],
    );
    const [a, b] = await service.findAll(true);
    expect(a.lastRacedAt).toBe('2025-01-02T03:04:05.000Z');
    expect(b).toMatchObject({ raceCount: 1, lastRacedAt: null });
  });
});

describe('TracksService.findOneDetailed', () => {
  it('limits the grouped query to the one track', async () => {
    const { service, qb } = makeService([{ id: 't1' }], [{ trackId: 't1', count: '3', lastRacedAt: null }]);
    const track = await service.findOneDetailed('t1');
    expect(track.raceCount).toBe(3);
    expect(qb.andWhere).toHaveBeenCalledWith('r.trackId = :trackId', { trackId: 't1' });
  });
});
