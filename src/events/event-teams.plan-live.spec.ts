import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EventTeamDriverSettingsService } from './event-team-driver-settings.service.js';
import { EventTeamDummyDriversService } from './event-team-dummy-drivers.service.js';
import { EventTeamsController } from './event-teams.controller.js';
import { EventTeamsService } from './event-teams.service.js';
import { type TeamPlanChange, TeamPlanEventsService } from './team-plan-events.service.js';

describe('EventTeamsService.findOneForEvent', () => {
  function setup(found: unknown) {
    const teamsRepository = { findOne: vi.fn().mockResolvedValue(found) };
    const service = new EventTeamsService(teamsRepository as never, {} as never);
    return { service, teamsRepository };
  }

  it('loads exactly one team of the event together with its guest drivers', async () => {
    const team = { id: 't1', eventId: 'e1', dummyDrivers: [{ id: 'd1' }] };
    const { service, teamsRepository } = setup(team);

    await expect(service.findOneForEvent('e1', 't1')).resolves.toBe(team);
    expect(teamsRepository.findOne).toHaveBeenCalledWith({
      where: { id: 't1', eventId: 'e1' },
      relations: { dummyDrivers: true },
    });
  });

  it('404s when the team is not part of that event', async () => {
    const { service } = setup(null);
    await expect(service.findOneForEvent('e1', 'other-event-team')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is exposed by the controller as GET :teamId', async () => {
    const findOneForEvent = vi.fn().mockResolvedValue({ id: 't1' });
    const controller = new EventTeamsController({ findOneForEvent } as never);
    await expect(controller.findOne('e1', 't1')).resolves.toEqual({ id: 't1' });
    expect(findOneForEvent).toHaveBeenCalledWith('e1', 't1');
  });
});

describe('which change kinds the plan page is told about', () => {
  const team = { id: 't1', eventId: 'e1' };

  it('a guest driver edit (availability / rename / add) is a drivers-only change', async () => {
    const dummiesRepository = {
      findOne: vi.fn().mockResolvedValue({ id: 'd1', eventTeamId: 't1', availableHours: [] }),
      save: vi.fn((v: unknown) => Promise.resolve(v)),
      create: vi.fn((v: unknown) => v),
    };
    const planEvents = { emit: vi.fn() };
    const service = new EventTeamDummyDriversService(
      dummiesRepository as never,
      { findOne: vi.fn().mockResolvedValue(team) } as never,
      {} as never,
      {} as never,
      {} as never,
      planEvents as never,
    );

    await service.create('e1', 't1', { name: 'Guest' }, 'u1');
    await service.update('e1', 't1', 'd1', { availableHours: [] }, 'u1');

    expect(planEvents.emit.mock.calls.map((c) => c[2])).toEqual(['drivers', 'drivers']);
  });

  it('removing a guest driver changes the inputs AND the stint rows (they go unassigned)', async () => {
    const planEvents = { emit: vi.fn() };
    const service = new EventTeamDummyDriversService(
      {
        findOne: vi.fn().mockResolvedValue({ id: 'd1', eventTeamId: 't1' }),
        remove: vi.fn().mockResolvedValue(undefined),
      } as never,
      { findOne: vi.fn().mockResolvedValue(team) } as never,
      { update: vi.fn().mockResolvedValue(undefined) } as never,
      { delete: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      planEvents as never,
    );

    await service.remove('e1', 't1', 'd1', 'u1');

    expect(planEvents.emit.mock.calls.map((c) => c[2])).toEqual(['drivers', 'stints']);
  });

  it('saving a driver pace/fuel row is a drivers-only change', async () => {
    const planEvents = { emit: vi.fn() };
    const service = new EventTeamDriverSettingsService(
      {
        findOne: vi.fn().mockResolvedValue({ eventTeamId: 't1', userId: 'u2' }),
        save: vi.fn((v: unknown) => Promise.resolve(v)),
      } as never,
      { findOne: vi.fn().mockResolvedValue(team) } as never,
      planEvents as never,
    );

    await service.upsert('e1', 't1', 'u2', { lapTimeDrySeconds: 95 }, 'u1');

    expect(planEvents.emit).toHaveBeenCalledTimes(1);
    expect(planEvents.emit).toHaveBeenCalledWith('e1', 't1', 'drivers', 'u1');
  });
});

describe('TeamPlanEventsService shutdown', () => {
  it('completes open streams on module destroy, and later emits are harmless', () => {
    const service = new TeamPlanEventsService();
    const seen: TeamPlanChange[] = [];
    let completed = false;
    service.stream('e1', 't1').subscribe({ next: (c) => seen.push(c), complete: () => (completed = true) });

    service.emit('e1', 't1', 'stints');
    service.onModuleDestroy();

    expect(completed).toBe(true);
    expect(() => service.emit('e1', 't1', 'stints')).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
