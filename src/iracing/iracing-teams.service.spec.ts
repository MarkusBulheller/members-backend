import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { CreateIracingTeamDto, UpdateIracingTeamDto } from './dto/update-iracing-team.dto.js';
import { IracingController } from './iracing.controller.js';
import { IracingTeamsService } from './iracing-teams.service.js';

function makeService(team: Record<string, unknown> | null) {
  const teamsRepository = {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(team),
    findOneOrFail: vi.fn().mockResolvedValue({ ...team, members: [] }),
    update: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const membersRepository = {
    delete: vi.fn().mockResolvedValue(undefined),
    create: vi.fn((row: unknown) => row),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const iracingService = { exchangeCodeForTeamRosters: vi.fn() };
  const service = new IracingTeamsService(teamsRepository as never, membersRepository as never, iracingService as never);
  return { service, teamsRepository, iracingService };
}

describe('IracingTeamsService.list', () => {
  it('returns only active teams by default', async () => {
    const { service, teamsRepository } = makeService(null);
    await service.list();
    expect(teamsRepository.find).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true } }));
  });

  it('returns every team with includeInactive', async () => {
    const { service, teamsRepository } = makeService(null);
    await service.list(true);
    expect(teamsRepository.find).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe('IracingController.listTeams', () => {
  const make = () => {
    const list = vi.fn().mockResolvedValue([]);
    const stub = {} as never;
    const controller = new IracingController(stub, stub, stub, stub, stub, stub, { list } as never, stub, stub);
    return { controller, list };
  };

  it('honours includeInactive=true only for admins', () => {
    const { controller, list } = make();
    controller.listTeams('true', { role: 'ADMIN' } as never);
    expect(list).toHaveBeenLastCalledWith(true);
    controller.listTeams('true', { role: 'MEMBER' } as never);
    expect(list).toHaveBeenLastCalledWith(false);
    controller.listTeams(undefined, { role: 'ADMIN' } as never);
    expect(list).toHaveBeenLastCalledWith(false);
  });
});

describe('IracingTeamsService.update', () => {
  const base = { teamId: 5, teamName: 'T', active: true, autoImport: false };

  it('404s for an unknown team', async () => {
    const { service } = makeService(null);
    await expect(service.update(5, { active: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns autoImport off when deactivating', async () => {
    const { service, teamsRepository } = makeService({ ...base, autoImport: true });
    await service.update(5, { active: false });
    expect(teamsRepository.update).toHaveBeenCalledWith({ teamId: 5 }, { active: false, autoImport: false });
  });

  it('rejects deactivating and watching in the same call', async () => {
    const { service } = makeService({ ...base });
    await expect(service.update(5, { active: false, autoImport: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses autoImport on an inactive team, and allows it once reactivated in the same call', async () => {
    const { service, teamsRepository } = makeService({ ...base, active: false });
    await expect(service.update(5, { autoImport: true })).rejects.toBeInstanceOf(BadRequestException);
    await service.update(5, { active: true, autoImport: true });
    expect(teamsRepository.update).toHaveBeenCalledWith({ teamId: 5 }, { active: true, autoImport: true });
  });

  it('toggles autoImport on an active team and leaves unspecified flags alone; accepts the negative id form', async () => {
    const { service, teamsRepository } = makeService({ ...base, autoImport: true });
    await service.update(-5, { autoImport: false });
    expect(teamsRepository.findOne).toHaveBeenCalledWith({ where: { teamId: 5 } });
    expect(teamsRepository.update).toHaveBeenCalledWith({ teamId: 5 }, { active: true, autoImport: false });
    await service.update(5, {});
    expect(teamsRepository.update).toHaveBeenLastCalledWith({ teamId: 5 }, { active: true, autoImport: true });
  });
});

describe('IracingTeamsService.sync', () => {
  it('never writes the admin-controlled flags, so a re-sync keeps them (and does not re-activate)', async () => {
    const { service, teamsRepository, iracingService } = makeService(null);
    iracingService.exchangeCodeForTeamRosters.mockResolvedValue([
      { teamId: -5, teamName: 'T', ownerCustId: 1, roster: [{ custId: 2, displayName: 'D' }] },
    ]);
    await service.sync('code', 'verifier');
    const [values, conflict] = teamsRepository.upsert.mock.calls[0];
    expect(conflict).toEqual(['teamId']);
    expect(values).toEqual({ teamId: 5, teamName: 'T', ownerCustId: 1, rosterCount: 1, manual: false });
    expect(values).not.toHaveProperty('active');
    expect(values).not.toHaveProperty('autoImport');
    expect(values).not.toHaveProperty('lastCheckedAt');
  });
});

describe('UpdateIracingTeamDto', () => {
  it('accepts booleans and rejects other types', async () => {
    expect(await validate(plainToInstance(UpdateIracingTeamDto, { active: false, autoImport: true }))).toHaveLength(0);
    expect(await validate(plainToInstance(UpdateIracingTeamDto, {}))).toHaveLength(0);
    expect(await validate(plainToInstance(UpdateIracingTeamDto, { active: 'no' }))).not.toHaveLength(0);
  });
});

describe('IracingTeamsService manual teams', () => {
  it('adds a team by hand with the positive id, no owner and no roster', async () => {
    const { service, teamsRepository } = makeService(null);
    await service.createManual({ teamId: -123456, teamName: 'Old Team' });
    expect(teamsRepository.insert).toHaveBeenCalledWith({
      teamId: 123456,
      teamName: 'Old Team',
      ownerCustId: 0,
      rosterCount: 0,
      manual: true,
    });
  });

  it('refuses an id that is already in the list, in either sign', async () => {
    const { service, teamsRepository } = makeService({ teamId: 55, teamName: 'Existing' });
    await expect(service.createManual({ teamId: 55, teamName: 'X' })).rejects.toBeInstanceOf(ConflictException);
    expect(teamsRepository.findOne).toHaveBeenCalledWith({ where: [{ teamId: 55 }, { teamId: -55 }] });
    expect(teamsRepository.insert).not.toHaveBeenCalled();
  });

  it('only removes a team that was added by hand', async () => {
    const synced = makeService({ teamId: 7, manual: false });
    await expect(synced.service.removeManual(7)).rejects.toBeInstanceOf(BadRequestException);
    expect(synced.teamsRepository.delete).not.toHaveBeenCalled();

    const manual = makeService({ teamId: 8, manual: true });
    await manual.service.removeManual(-8);
    expect(manual.teamsRepository.delete).toHaveBeenCalledWith({ teamId: 8 });

    await expect(makeService(null).service.removeManual(9)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renames a manual team but not a synced one', async () => {
    const manual = makeService({ teamId: 8, manual: true, active: true, autoImport: false });
    await manual.service.update(8, { teamName: 'Renamed' });
    expect(manual.teamsRepository.update).toHaveBeenCalledWith(
      { teamId: 8 },
      { active: true, autoImport: false, teamName: 'Renamed' },
    );

    const synced = makeService({ teamId: 7, manual: false, active: true, autoImport: false });
    await expect(synced.service.update(7, { teamName: 'Renamed' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a real sync turns a hand-added team into a normal synced one', async () => {
    const { service, teamsRepository, iracingService } = makeService(null);
    iracingService.exchangeCodeForTeamRosters.mockResolvedValue([
      { teamId: -77, teamName: 'Found', ownerCustId: 5, roster: [{ custId: 1, displayName: 'A' }] },
    ]);
    await service.sync('c', 'v');
    expect(teamsRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ teamId: 77, manual: false }), ['teamId']);
  });

  it('validates the create body (abs id, trimmed name, bounds)', async () => {
    const ok = plainToInstance(CreateIracingTeamDto, { teamId: -42, teamName: '  Name  ' });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.teamId).toBe(42);
    expect(ok.teamName).toBe('Name');
    for (const bad of [{ teamId: 0, teamName: 'x' }, { teamId: 1.5, teamName: 'x' }, { teamId: 3, teamName: '   ' }, { teamId: 3, teamName: 'x'.repeat(101) }]) {
      expect((await validate(plainToInstance(CreateIracingTeamDto, bad))).length).toBeGreaterThan(0);
    }
  });
});
