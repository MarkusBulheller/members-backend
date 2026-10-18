import { describe, expect, it, vi } from 'vitest';
import { CarTrackSetupsService } from './car-track-setups.service.js';

function makeService() {
  const setupsRepository = {
    find: vi.fn().mockResolvedValue([{ id: 's1' }]),
    findOne: vi.fn().mockResolvedValue(null),
    findOneOrFail: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id })),
    create: vi.fn().mockImplementation((s) => ({ id: 'new', ...s })),
    save: vi.fn().mockImplementation(async (s) => s),
  };
  return { service: new CarTrackSetupsService(setupsRepository as never), setupsRepository };
}

describe('CarTrackSetupsService.findByTrack', () => {
  it('lists setups for the track, active cars only, with the car joined', async () => {
    const { service, setupsRepository } = makeService();

    await expect(service.findByTrack('t1')).resolves.toEqual([{ id: 's1' }]);

    expect(setupsRepository.find).toHaveBeenCalledWith({
      where: { trackId: 't1', car: { active: true } },
      relations: { car: true },
      order: { car: { name: 'ASC' } },
    });
  });
});

describe('CarTrackSetupsService notes', () => {
  it('stores notes on create and null when omitted', async () => {
    const { service, setupsRepository } = makeService();

    await service.create('c1', { trackId: 't1', fuelPerLapLiters: 2.85, notes: 'Bus stop costs fuel' });
    expect(setupsRepository.create).toHaveBeenLastCalledWith({
      carId: 'c1',
      trackId: 't1',
      fuelPerLapLiters: '2.85',
      pitLaneTimeSeconds: null,
      notes: 'Bus stop costs fuel',
    });

    await service.create('c1', { trackId: 't2' });
    expect(setupsRepository.create).toHaveBeenLastCalledWith(expect.objectContaining({ notes: null }));
  });

  it('updates notes only when provided', async () => {
    const { service, setupsRepository } = makeService();
    const setup = { id: 's1', notes: 'old', fuelPerLapLiters: '2.5' };
    setupsRepository.findOne.mockResolvedValue(setup);

    await service.update('s1', { notes: 'new' });
    expect(setup).toMatchObject({ notes: 'new', fuelPerLapLiters: '2.5' });

    await service.update('s1', {});
    expect(setup.notes).toBe('new');
  });
});
