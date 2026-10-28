import { describe, expect, it, vi } from 'vitest';
import { EventTeamsService } from './event-teams.service.js';

function makeService(teams: { id: string }[], linked: { id: string; eventTeamId: string }[]) {
  const teamsRepository = {
    find: vi.fn().mockResolvedValue(teams),
    findOne: vi.fn().mockResolvedValue(teams[0] ?? null),
  };
  const resultsRepository = { find: vi.fn().mockResolvedValue(linked) };
  const service = new EventTeamsService(teamsRepository as never, {} as never, undefined, resultsRepository as never);
  return { service, resultsRepository };
}

describe('EventTeamsService raceResultId', () => {
  it('adds the linked result id to each team and null where none is linked', async () => {
    const { service } = makeService([{ id: 't1' }, { id: 't2' }], [{ id: 'r1', eventTeamId: 't1' }]);
    const teams = await service.listForEvent('e1');
    expect(teams.map((t) => [t.id, t.raceResultId])).toEqual([
      ['t1', 'r1'],
      ['t2', null],
    ]);
  });

  it('takes the first (latest) result when several are linked to one team', async () => {
    const { service } = makeService(
      [{ id: 't1' }],
      [
        { id: 'latest', eventTeamId: 't1' },
        { id: 'older', eventTeamId: 't1' },
      ],
    );
    const [team] = await service.listForEvent('e1');
    expect(team.raceResultId).toBe('latest');
  });

  it('adds it to the single-team read too', async () => {
    const { service } = makeService([{ id: 't1' }], [{ id: 'r1', eventTeamId: 't1' }]);
    await expect(service.findOneForEvent('e1', 't1')).resolves.toMatchObject({ id: 't1', raceResultId: 'r1' });
  });

  it('skips the lookup for an event without teams', async () => {
    const { service, resultsRepository } = makeService([], []);
    await expect(service.listForEvent('e1')).resolves.toEqual([]);
    expect(resultsRepository.find).not.toHaveBeenCalled();
  });
});
