import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RaceResultsService } from './race-results.service.js';

const data = {
  subsessionId: 11,
  teamId: 100,
  seriesName: 'IMSA',
  trackName: 'Daytona',
  trackConfig: null,
  trackId: null,
  carName: 'BMW M4 GT3',
  carId: null,
  carClassName: 'GT3 Class',
  startTime: '2026-10-24T12:00:00Z',
  endTime: '2026-10-24T14:00:00Z',
  startingPosition: 3,
  finishingPosition: 2,
  startingPositionInClass: 2,
  finishingPositionInClass: 1,
  teamLapsComplete: 80,
  totalLaps: 82,
  teamIncidents: 4,
  splitNumber: null,
  totalSplits: null,
  drivers: [],
  laps: [],
};

function makeService(existing: unknown = null) {
  const raceResultsRepository = {
    findOne: vi.fn(async (options: { where: { id?: string } }) => (options.where.id ? { id: options.where.id, driverStints: [], laps: [], teamId: 100 } : existing)),
    create: vi.fn((row: Record<string, unknown>) => ({ ...row })),
    save: vi.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'new-result' })),
  };
  const teamsRepository = { findOne: vi.fn().mockResolvedValue(null) };
  const stub = { save: vi.fn(), create: vi.fn((row: unknown) => row) };
  const lookup = {
    lookupAsAdmin: vi.fn().mockResolvedValue(data),
    lookupWithToken: vi.fn().mockResolvedValue(data),
  };
  const cars = { ensureExists: vi.fn().mockResolvedValue({ id: 'car1' }) };
  const tracks = { ensureExists: vi.fn().mockResolvedValue({ id: 'track1' }) };
  const link = { linkAndComplete: vi.fn().mockResolvedValue(undefined) };
  const service = new RaceResultsService(
    raceResultsRepository as never,
    stub as never,
    stub as never,
    teamsRepository as never,
    lookup as never,
    {} as never,
    cars as never,
    tracks as never,
    {} as never,
    {} as never,
    link as never,
  );
  return { service, raceResultsRepository, lookup, link };
}

describe('RaceResultsService import', () => {
  it('the manual flow (importFromIracing) looks up as the admin and records source MANUAL + imported_at', async () => {
    const { service, raceResultsRepository, lookup, link } = makeService();
    const result = await service.importFromIracing('admin-1', 11, 100);
    expect(lookup.lookupAsAdmin).toHaveBeenCalledWith('admin-1', 11, 100);
    expect(lookup.lookupWithToken).not.toHaveBeenCalled();
    const created = raceResultsRepository.create.mock.calls[0][0];
    expect(created).toMatchObject({ importSource: 'MANUAL', subsessionId: 11, teamId: 100 });
    expect(created.importedAt).toBeInstanceOf(Date);
    expect(link.linkAndComplete).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('new-result');
  });

  it('the auto flow uses the supplied access token (no admin user) and records source AUTO', async () => {
    const { service, raceResultsRepository, lookup, link } = makeService();
    await service.importWithOptions(11, 100, { source: 'AUTO', accessToken: 'tok' });
    expect(lookup.lookupWithToken).toHaveBeenCalledWith('tok', 11, 100);
    expect(lookup.lookupAsAdmin).not.toHaveBeenCalled();
    expect(raceResultsRepository.create.mock.calls[0][0]).toMatchObject({ importSource: 'AUTO' });
    expect(link.linkAndComplete).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-result' }));
  });

  it('needs either a token or an admin', async () => {
    const { service } = makeService();
    await expect(service.importWithOptions(11, 100, { source: 'AUTO' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still refuses a duplicate (subsession, team) with a conflict and does not link', async () => {
    const { service, link, lookup } = makeService({ id: 'old' });
    await expect(service.importFromIracing('admin-1', 11, 100)).rejects.toBeInstanceOf(ConflictException);
    expect(lookup.lookupAsAdmin).not.toHaveBeenCalled();
    expect(link.linkAndComplete).not.toHaveBeenCalled();
  });
});
