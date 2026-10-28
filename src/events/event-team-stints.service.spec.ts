import { describe, expect, it, vi } from 'vitest';
import { EventTeamStintsService } from './event-team-stints.service.js';

function setup(existing: Record<string, unknown> | null = null) {
  const stintsRepository = {
    maximum: vi.fn().mockResolvedValue(null),
    create: vi.fn((v: Record<string, unknown>) => v),
    save: vi.fn((v: Record<string, unknown>) => Promise.resolve(v)),
    findOne: vi.fn().mockResolvedValue(existing),
  };
  const teamsRepository = { findOne: vi.fn().mockResolvedValue({ id: 't1', eventId: 'e1' }) };
  const service = new EventTeamStintsService(stintsRepository as never, teamsRepository as never);
  return { service, stintsRepository };
}

describe('EventTeamStintsService tyre fields', () => {
  it('creates a stint with a full change by default', async () => {
    const { service } = setup();
    const stint = await service.create('e1', 't1', {});
    expect(stint).toMatchObject({ tyreChange: true, tyresChanged: 4 });
  });

  it('stores tyresChanged and syncs tyreChange on create', async () => {
    const { service } = setup();
    expect(await service.create('e1', 't1', { tyresChanged: 2 })).toMatchObject({ tyreChange: true, tyresChanged: 2 });
    expect(await service.create('e1', 't1', { tyresChanged: 0 })).toMatchObject({ tyreChange: false, tyresChanged: 0 });
  });

  it('maps a legacy tyreChange-only create to 4 / 0', async () => {
    const { service } = setup();
    expect(await service.create('e1', 't1', { tyreChange: false })).toMatchObject({ tyreChange: false, tyresChanged: 0 });
    expect(await service.create('e1', 't1', { tyreChange: true })).toMatchObject({ tyreChange: true, tyresChanged: 4 });
  });

  it('syncs tyreChange when updating tyresChanged', async () => {
    const { service } = setup({ id: 's1', tyreChange: true, tyresChanged: 4 });
    const stint = await service.update('e1', 't1', 's1', { tyresChanged: 0 });
    expect(stint).toMatchObject({ tyreChange: false, tyresChanged: 0 });
  });

  it('leaves the tyre fields alone when the update does not carry them', async () => {
    const { service } = setup({ id: 's1', tyreChange: true, tyresChanged: 2, driverUserId: null });
    const stint = await service.update('e1', 't1', 's1', { durationMinutes: 30 });
    expect(stint).toMatchObject({ tyreChange: true, tyresChanged: 2 });
  });

  it('upgrades a legacy null row on a bare tyreChange update', async () => {
    const { service } = setup({ id: 's1', tyreChange: true, tyresChanged: null });
    const stint = await service.update('e1', 't1', 's1', { tyreChange: false });
    expect(stint).toMatchObject({ tyreChange: false, tyresChanged: 0 });
  });
});

describe('EventTeamStintsService start now / restart', () => {
  it('toggles: a first call sets the start, a second call clears it', async () => {
    const set = setup({ id: 's1', actualStartAt: null });
    expect((await set.service.toggleStartNow('e1', 't1', 's1')).actualStartAt).toBeInstanceOf(Date);

    const clear = setup({ id: 's1', actualStartAt: new Date('2026-10-24T12:00:00Z') });
    expect((await clear.service.toggleStartNow('e1', 't1', 's1')).actualStartAt).toBeNull();
  });

  it('restart sets the start to now even when the stint already has one', async () => {
    const before = Date.now();
    const { service } = setup({ id: 's1', actualStartAt: new Date('2026-10-24T12:00:00Z') });
    const stint = await service.toggleStartNow('e1', 't1', 's1', undefined, true);
    expect(stint.actualStartAt).toBeInstanceOf(Date);
    expect((stint.actualStartAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('EventTeamStintsService.moveTo (drag and drop)', () => {
  function withList(orders: number[]) {
    const rows = orders.map((order, i) => ({ id: `s${i}`, order }));
    const stintsRepository = {
      find: vi.fn().mockResolvedValue(rows.map((r) => ({ ...r }))),
      save: vi.fn((v: unknown) => Promise.resolve(v)),
    };
    const teamsRepository = { findOne: vi.fn().mockResolvedValue({ id: 't1', eventId: 'e1' }) };
    const service = new EventTeamStintsService(stintsRepository as never, teamsRepository as never);
    return { service, stintsRepository };
  }

  it('moves a stint down and renumbers only the rows that changed', async () => {
    const { service, stintsRepository } = withList([0, 1, 2, 3]);
    await service.moveTo('e1', 't1', 's0', 2);
    const saved = stintsRepository.save.mock.calls[0][0] as { id: string; order: number }[];
    expect(Object.fromEntries(saved.map((s) => [s.id, s.order]))).toEqual({ s1: 0, s2: 1, s0: 2 });
  });

  it('moves a stint up past several others', async () => {
    const { service, stintsRepository } = withList([0, 1, 2, 3]);
    await service.moveTo('e1', 't1', 's3', 0);
    const saved = stintsRepository.save.mock.calls[0][0] as { id: string; order: number }[];
    expect(Object.fromEntries(saved.map((s) => [s.id, s.order]))).toEqual({ s3: 0, s0: 1, s1: 2, s2: 3 });
  });

  it('clamps an index past the end to last and does nothing when the position is unchanged', async () => {
    const last = withList([0, 1, 2]);
    await last.service.moveTo('e1', 't1', 's0', 99);
    const saved = last.stintsRepository.save.mock.calls[0][0] as { id: string; order: number }[];
    expect(Object.fromEntries(saved.map((s) => [s.id, s.order]))).toEqual({ s1: 0, s2: 1, s0: 2 });

    const same = withList([0, 1, 2]);
    await same.service.moveTo('e1', 't1', 's1', 1);
    expect(same.stintsRepository.save).not.toHaveBeenCalled();
  });

  it('heals gaps in the stored order while moving', async () => {
    const { service, stintsRepository } = withList([0, 5, 9]);
    await service.moveTo('e1', 't1', 's2', 0);
    const saved = stintsRepository.save.mock.calls[0][0] as { id: string; order: number }[];
    expect(Object.fromEntries(saved.map((s) => [s.id, s.order]))).toEqual({ s2: 0, s0: 1, s1: 2 });
  });

  it('throws for a stint that is not in the team', async () => {
    const { service } = withList([0, 1]);
    await expect(service.moveTo('e1', 't1', 'nope', 0)).rejects.toThrow('Stint not found');
  });
});
