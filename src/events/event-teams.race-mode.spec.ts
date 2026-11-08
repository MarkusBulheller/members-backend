import { describe, expect, it, vi } from 'vitest';
import { EventTeamsService } from './event-teams.service.js';

describe('EventTeamsService.update: race mode', () => {
  function setup(team: Record<string, unknown>) {
    const teamsRepository = {
      findOne: vi.fn().mockResolvedValue(team),
      save: vi.fn(async (value: unknown) => value),
    };
    const planEvents = { emit: vi.fn() };
    const service = new EventTeamsService(teamsRepository as never, {} as never, planEvents as never);
    return { service, teamsRepository, planEvents };
  }

  it('switches race mode on and tells the plan pages (a team change)', async () => {
    const { service, teamsRepository, planEvents } = setup({ id: 't1', eventId: 'e1', raceMode: false });
    const saved = await service.update('e1', 't1', { raceMode: true }, 'u1');
    expect(saved.raceMode).toBe(true);
    expect(teamsRepository.save).toHaveBeenCalledTimes(1);
    expect(planEvents.emit).toHaveBeenCalledWith('e1', 't1', 'team', 'u1');
  });

  it('switches it off again', async () => {
    const { service } = setup({ id: 't1', eventId: 'e1', raceMode: true });
    expect((await service.update('e1', 't1', { raceMode: false })).raceMode).toBe(false);
  });

  it('leaves race mode alone when an update does not mention it', async () => {
    const { service } = setup({ id: 't1', eventId: 'e1', raceMode: true, name: 'A' });
    const saved = await service.update('e1', 't1', { name: 'B' });
    expect(saved.raceMode).toBe(true);
    expect(saved.name).toBe('B');
  });
});
