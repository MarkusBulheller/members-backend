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
