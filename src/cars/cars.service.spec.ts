import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CarsService, resolveUploaderName } from './cars.service.js';

const unlinkMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('node:fs/promises', () => ({ unlink: unlinkMock }));

function makeQueryBuilder(rows: unknown[]) {
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['select', 'addSelect', 'where', 'groupBy']) {
    qb[name] = vi.fn().mockReturnValue(qb);
  }
  qb.getRawMany = vi.fn().mockResolvedValue(rows);
  return qb;
}

function makeService(options?: { cars?: unknown[]; countRows?: unknown[]; childCountRows?: unknown[]; users?: unknown[]; profiles?: unknown[] }) {
  const carsRepository = {
    find: vi.fn().mockResolvedValue(options?.cars ?? []),
    findOne: vi.fn(),
    save: vi.fn().mockImplementation(async (c) => c),
    manager: { createQueryBuilder: vi.fn() },
  };
  const childCountQb = makeQueryBuilder(options?.childCountRows ?? []);
  carsRepository.manager.createQueryBuilder.mockReturnValue(childCountQb);
  const countQb = makeQueryBuilder(options?.countRows ?? []);
  const raceResultsRepository = {
    createQueryBuilder: vi.fn().mockReturnValue(countQb),
    count: vi.fn().mockResolvedValue(7),
  };
  const driverProfilesRepository = { find: vi.fn().mockResolvedValue(options?.profiles ?? []) };
  const usersRepository = { find: vi.fn().mockResolvedValue(options?.users ?? []) };
  const service = new CarsService(
    carsRepository as never,
    raceResultsRepository as never,
    driverProfilesRepository as never,
    usersRepository as never,
  );
  return { service, carsRepository, raceResultsRepository, driverProfilesRepository, usersRepository, countQb, childCountQb };
}

describe('resolveUploaderName', () => {
  it('prefers the driver profile display name', () => {
    expect(
      resolveUploaderName({ displayName: ' Markus ' }, { discordGlobalName: 'MB', discordUsername: 'mb#1' }),
    ).toBe('Markus');
  });

  it('falls back to the Discord global name, then username', () => {
    expect(resolveUploaderName(undefined, { discordGlobalName: 'MB', discordUsername: 'mb' })).toBe('MB');
    expect(resolveUploaderName(undefined, { discordGlobalName: null, discordUsername: 'mb' })).toBe('mb');
  });

  it('returns null when the uploader no longer exists', () => {
    expect(resolveUploaderName(undefined, undefined)).toBeNull();
  });
});

describe('CarsService.findAll', () => {
  it('adds raceCount from one grouped query (0 for cars without results)', async () => {
    const { service, countQb, raceResultsRepository } = makeService({
      cars: [
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
      ],
      countRows: [{ carId: 'c1', count: '61' }],
    });

    const cars = await service.findAll(false);

    expect(cars.map((c) => [c.id, c.raceCount])).toEqual([
      ['c1', 61],
      ['c2', 0],
    ]);
    expect(raceResultsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(countQb.groupBy).toHaveBeenCalledWith('r.carId');
  });

  it('returns liveryCount / trackSetupCount from grouped counts instead of loading liveries and setups', async () => {
    const { service, carsRepository, childCountQb, usersRepository } = makeService({
      cars: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }],
      childCountRows: [{ carId: 'c1', count: '4' }],
    });

    const cars = await service.findAll(true);

    expect(carsRepository.find).toHaveBeenCalledWith({ where: {}, order: { name: 'ASC' } });
    expect(carsRepository.manager.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(childCountQb.groupBy).toHaveBeenCalledWith('child.carId');
    expect(cars.map((c) => [c.liveryCount, c.trackSetupCount])).toEqual([
      [4, 4],
      [0, 0],
    ]);
    expect(cars[0]).not.toHaveProperty('liveries');
    expect(cars[0]).not.toHaveProperty('trackSetups');
    // No livery uploader-name lookups on the list any more.
    expect(usersRepository.find).not.toHaveBeenCalled();
  });

  it('filters to active cars unless includeInactive is set', async () => {
    const active = makeService();
    await active.service.findAll(false);
    expect(active.carsRepository.find).toHaveBeenCalledWith({ where: { active: true }, order: { name: 'ASC' } });
  });
});

describe('CarsService.attachUploaderNames', () => {
  it('resolves uploader names on liveries with a single users + profiles lookup', async () => {
    const { service, usersRepository, driverProfilesRepository } = makeService({
      users: [
        { id: 'u1', discordGlobalName: null, discordUsername: 'markus_dc' },
        { id: 'u2', discordGlobalName: 'Jonas G', discordUsername: 'jonas' },
      ],
      profiles: [{ userId: 'u1', displayName: 'Markus' }],
    });
    const cars = [
      {
        id: 'c1',
        liveries: [
          { id: 'l1', uploadedByUserId: 'u1' },
          { id: 'l2', uploadedByUserId: 'u2' },
          { id: 'l3', uploadedByUserId: 'gone' },
        ],
      },
      { id: 'c2', liveries: [{ id: 'l4', uploadedByUserId: 'u1' }] },
    ] as never as Parameters<typeof service.attachUploaderNames>[0];

    await service.attachUploaderNames(cars);

    expect(cars[0].liveries.map((l) => l.uploadedByName)).toEqual(['Markus', 'Jonas G', null]);
    expect(cars[1].liveries[0].uploadedByName).toBe('Markus');
    expect(usersRepository.find).toHaveBeenCalledTimes(1);
    expect(driverProfilesRepository.find).toHaveBeenCalledTimes(1);
  });

  it('skips the user lookups entirely when there are no liveries', async () => {
    const { service, usersRepository } = makeService();
    await service.attachUploaderNames([{ id: 'c1', liveries: [] }] as never);
    expect(usersRepository.find).not.toHaveBeenCalled();
  });
});

describe('CarsService.findOneDetailed', () => {
  it('adds the race count for a single car', async () => {
    const { service, carsRepository, raceResultsRepository } = makeService();
    carsRepository.findOne.mockResolvedValue({ id: 'c1', liveries: [] });

    const car = await service.findOneDetailed('c1');

    expect(car.raceCount).toBe(7);
    expect(raceResultsRepository.count).toHaveBeenCalledWith({ where: { carId: 'c1' } });
  });
});

describe('CarsService retire / restore', () => {
  it('deactivate soft-retires and PATCH active:true restores', async () => {
    const { service, carsRepository } = makeService();
    const car = { id: 'c1', active: true, imageUrl: null, liveries: [] };
    carsRepository.findOne.mockResolvedValue(car);

    await service.deactivate('c1');
    expect(car.active).toBe(false);

    await service.update('c1', { active: true });
    expect(car.active).toBe(true);
  });
});

describe('CarsService image replacement', () => {
  beforeEach(() => unlinkMock.mockClear());

  it('deletes the previous file when an uploaded image is replaced', async () => {
    const { service, carsRepository } = makeService();
    carsRepository.findOne.mockResolvedValue({ id: 'c1', imageUrl: '/uploads/cars/old.png', liveries: [] });

    await service.update('c1', { imageUrl: '/uploads/cars/new.png' });

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(String(unlinkMock.mock.calls[0][0])).toMatch(/old\.png$/);
  });

  it('never deletes iRacing CDN images or traversal-looking paths', async () => {
    const { service, carsRepository } = makeService();
    carsRepository.findOne.mockResolvedValueOnce({
      id: 'c1',
      imageUrl: 'https://images-static.iracing.com/x.png',
      liveries: [],
    });
    await service.update('c1', { imageUrl: '/uploads/cars/new.png' });
    carsRepository.findOne.mockResolvedValueOnce({ id: 'c1', imageUrl: '/uploads/cars/../secret.png', liveries: [] });
    await service.update('c1', { imageUrl: '/uploads/cars/new.png' });

    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('treats an empty imageUrl as "clear the image": stores null and deletes the uploaded file', async () => {
    const { service, carsRepository } = makeService();
    const car = { id: 'c1', imageUrl: '/uploads/cars/old.png', liveries: [] };
    carsRepository.findOne.mockResolvedValue(car);

    await service.update('c1', { imageUrl: '' });

    expect(car.imageUrl).toBeNull();
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the file when the image is unchanged', async () => {
    const { service, carsRepository } = makeService();
    carsRepository.findOne.mockResolvedValue({ id: 'c1', imageUrl: '/uploads/cars/same.png', liveries: [] });
    await service.update('c1', { imageUrl: '/uploads/cars/same.png', notes: 'x' });
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});
