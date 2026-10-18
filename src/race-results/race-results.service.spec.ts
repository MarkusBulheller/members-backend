import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RaceResultsService } from './race-results.service.js';

/** Builds a RaceResultsService with just the repositories the single-result lookups touch;
 * every other collaborator is an inert stub. */
function makeService(opts: { result?: Record<string, unknown> | null; team?: Record<string, unknown> | null }) {
  const raceResultsRepository = { findOne: vi.fn().mockResolvedValue(opts.result ?? null) };
  const teamsRepository = { findOne: vi.fn().mockResolvedValue(opts.team ?? null) };
  const stub = {} as never;
  const service = new RaceResultsService(
    raceResultsRepository as never,
    stub,
    stub,
    teamsRepository as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  return { service, raceResultsRepository, teamsRepository };
}

describe('RaceResultsService team name resolution', () => {
  it('adds the synced team name to a result found by id', async () => {
    const { service, teamsRepository } = makeService({
      result: { id: 'r1', teamId: 287336, driverStints: [], laps: [] },
      team: { teamId: 287336, teamName: 'W2W Racing Red' },
    });

    const result = await service.findByIdOrThrow('r1');

    expect(teamsRepository.findOne).toHaveBeenCalledWith({ where: { teamId: 287336 } });
    expect(result.teamName).toBe('W2W Racing Red');
    expect(result.id).toBe('r1');
  });

  it('sets teamName to null when the team has not been synced', async () => {
    const { service } = makeService({ result: { id: 'r1', teamId: 1, driverStints: [], laps: [] }, team: null });

    const result = await service.findByIdOrThrow('r1');

    expect(result.teamName).toBeNull();
  });

  it('adds the team name to a result found by share token', async () => {
    const { service } = makeService({
      result: { id: 'r2', teamId: 5, shareToken: 'tok', driverStints: [], laps: [] },
      team: { teamId: 5, teamName: 'W2W Racing Blue' },
    });

    const result = await service.findByShareTokenOrThrow('tok');

    expect(result.teamName).toBe('W2W Racing Blue');
  });

  it('still throws NotFound (without a team lookup) for unknown results', async () => {
    const { service, teamsRepository } = makeService({ result: null });

    await expect(service.findByIdOrThrow('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findByShareTokenOrThrow('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(teamsRepository.findOne).not.toHaveBeenCalled();
  });
});

describe('RaceResultsService list shapes', () => {
  function makeListService() {
    const raceResultsRepository = { find: vi.fn().mockResolvedValue([{ id: 'r1' }]) };
    const stub = {} as never;
    const service = new RaceResultsService(
      raceResultsRepository as never,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    return { service, raceResultsRepository };
  }

  it('list() does not load driverStints or laps', async () => {
    const { service, raceResultsRepository } = makeListService();
    await service.list();
    expect(raceResultsRepository.find).toHaveBeenCalledWith({ order: { startTime: 'DESC' } });
  });

  it('findByCarId() / findByTrackId() filter by FK without loading driverStints', async () => {
    const { service, raceResultsRepository } = makeListService();
    await service.findByCarId('c1');
    await service.findByTrackId('t1');
    expect(raceResultsRepository.find).toHaveBeenNthCalledWith(1, { where: { carId: 'c1' }, order: { startTime: 'DESC' } });
    expect(raceResultsRepository.find).toHaveBeenNthCalledWith(2, {
      where: { trackId: 't1' },
      order: { startTime: 'DESC' },
    });
  });
});
