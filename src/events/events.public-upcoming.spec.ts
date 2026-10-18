import { describe, expect, it, vi } from 'vitest';
import { EventsService } from './events.service.js';

function makeService(rows: unknown[]) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['leftJoinAndSelect', 'where', 'orderBy', 'take']) {
    qb[name] = vi.fn().mockReturnValue(qb);
  }
  qb.getMany = vi.fn().mockResolvedValue(rows);
  const eventsRepository = { createQueryBuilder: vi.fn().mockReturnValue(qb) };
  // Bypass the constructor: this path only needs the events repository.
  const service = Object.create(EventsService.prototype) as EventsService;
  (service as unknown as { eventsRepository: unknown }).eventsRepository = eventsRepository;
  return { service, qb, eventsRepository };
}

describe('EventsService.findPublicUpcoming', () => {
  it('filters unfinished events and applies the limit in SQL, mapping to the public shape', async () => {
    const startsAt = new Date('2026-11-01T12:00:00Z');
    const { service, qb } = makeService([
      { id: 'e1', title: 'Daytona', track: { name: 'Daytona' }, carClasses: ['GTP'], startsAt, extra: 'ignored' },
    ]);

    await expect(service.findPublicUpcoming(4)).resolves.toEqual([
      { id: 'e1', title: 'Daytona', trackName: 'Daytona', carClasses: ['GTP'], startsAt: startsAt.toISOString() },
    ]);
    expect(qb.take).toHaveBeenCalledWith(4);
    expect(qb.orderBy).toHaveBeenCalledWith('event.startsAt', 'ASC');
    const [where, params] = qb.where.mock.calls[0] as [string, { now: Date }];
    expect(where).toContain('COALESCE');
    expect(where).toContain('>= :now');
    expect(params.now).toBeInstanceOf(Date);
  });

  it('returns nothing for a non-positive limit without querying', async () => {
    const { service, eventsRepository } = makeService([]);
    await expect(service.findPublicUpcoming(0)).resolves.toEqual([]);
    expect(eventsRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
