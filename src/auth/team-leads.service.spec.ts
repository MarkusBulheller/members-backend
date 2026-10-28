import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ReplaceEventTeamLeadsDto } from '../events/dto/replace-event-team-leads.dto.js';
import { EventTeamLeadsController } from '../events/event-team-leads.controller.js';
import { EventTeamLead } from '../events/event-team-lead.entity.js';
import { TeamLeadsService } from './team-leads.service.js';

const EVENT = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const TEAM_B = '33333333-3333-4333-8333-333333333333';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface Opts {
  team?: object | null;
  /** user ids that exist as APPROVED users */
  approved?: string[];
  /** user ids with an active signup on the crew */
  placed?: string[];
  rows?: object[];
  userApproved?: boolean;
}

function makeService(opts: Opts = {}) {
  const manager = { delete: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
  const leads = {
    find: vi.fn().mockResolvedValue(opts.rows ?? []),
    manager: { transaction: vi.fn(async (fn: (m: typeof manager) => Promise<void>) => fn(manager)) },
  };
  const eventTeams = {
    findOne: vi.fn().mockResolvedValue(opts.team === undefined ? { id: TEAM, eventId: EVENT } : opts.team),
  };
  const signups = { find: vi.fn().mockResolvedValue((opts.placed ?? []).map((userId) => ({ userId, eventTeamId: TEAM }))) };
  const users = {
    find: vi.fn().mockResolvedValue((opts.approved ?? []).map((id) => ({ id }))),
    exists: vi.fn().mockResolvedValue(opts.userApproved ?? true),
  };
  const service = new TeamLeadsService(leads as never, eventTeams as never, signups as never, users as never);
  return { service, leads, eventTeams, signups, users, manager };
}

describe('TeamLeadsService', () => {
  it("lists a crew's leads as { userId, name } after checking the crew belongs to the event", async () => {
    const { service, leads, eventTeams } = makeService({
      rows: [
        { userId: U1, user: { discordGlobalName: 'Alice', discordUsername: 'alice#1' } },
        { userId: U2, user: { discordGlobalName: null, discordUsername: 'bob' } },
      ],
    });
    await expect(service.listForEventTeam(EVENT, TEAM)).resolves.toEqual([
      { userId: U1, name: 'Alice' },
      { userId: U2, name: 'bob' },
    ]);
    expect(eventTeams.findOne).toHaveBeenCalledWith({ where: { id: TEAM, eventId: EVENT } });
    expect(leads.find).toHaveBeenCalledWith(expect.objectContaining({ where: { eventTeamId: TEAM } }));
  });

  it('404s listing / replacing for a crew that is not part of the event', async () => {
    const { service, manager } = makeService({ team: null });
    await expect(service.listForEventTeam(EVENT, TEAM)).rejects.toThrow(NotFoundException);
    await expect(service.replaceForEventTeam(EVENT, TEAM, [U1])).rejects.toThrow(NotFoundException);
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('replaces the lead set in one transaction, de-duplicating', async () => {
    const { service, manager } = makeService({ approved: [U1, U2], placed: [U1, U2] });
    await service.replaceForEventTeam(EVENT, TEAM, [U1, U2, U1]);
    expect(manager.delete).toHaveBeenCalledWith(EventTeamLead, { eventTeamId: TEAM });
    expect(manager.insert).toHaveBeenCalledWith(EventTeamLead, [
      { eventTeamId: TEAM, userId: U1 },
      { eventTeamId: TEAM, userId: U2 },
    ]);
  });

  it('an empty set clears the leads without inserting or validating', async () => {
    const { service, manager, users, signups } = makeService();
    await service.replaceForEventTeam(EVENT, TEAM, []);
    expect(manager.delete).toHaveBeenCalledWith(EventTeamLead, { eventTeamId: TEAM });
    expect(manager.insert).not.toHaveBeenCalled();
    expect(users.find).not.toHaveBeenCalled();
    expect(signups.find).not.toHaveBeenCalled();
  });

  it('rejects a user who is not on this crew (400) and writes nothing', async () => {
    const { service, manager } = makeService({ approved: [U1, U2], placed: [U1] });
    await expect(service.replaceForEventTeam(EVENT, TEAM, [U1, U2])).rejects.toThrow(/placed on this crew/);
    await expect(service.replaceForEventTeam(EVENT, TEAM, [U1, U2])).rejects.toThrow(BadRequestException);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('looks placement up on the addressed crew only, ignoring cancelled signups', async () => {
    const { service, signups } = makeService({ approved: [U1], placed: [U1] });
    await service.replaceForEventTeam(EVENT, TEAM, [U1]);
    const where = signups.find.mock.calls[0][0].where;
    expect(where.eventTeamId).toBe(TEAM);
    expect(where.status.type).toBe('not');
    expect(where.status.value).toBe('CANCELLED');
  });

  it('rejects unknown or unapproved members (400) and writes nothing', async () => {
    const { service, manager } = makeService({ approved: [U1], placed: [U1, U3] });
    await expect(service.replaceForEventTeam(EVENT, TEAM, [U1, U3])).rejects.toThrow(/approved members/);
    await expect(service.replaceForEventTeam(EVENT, TEAM, [U1, U3])).rejects.toThrow(BadRequestException);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('rejects more than 5 leads (400) and writes nothing', async () => {
    const ids = ['1', '2', '3', '4', '5', '6'].map((n) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`);
    const { service, manager } = makeService({ approved: ids, placed: ids });
    await expect(service.replaceForEventTeam(EVENT, TEAM, ids)).rejects.toThrow(BadRequestException);
    expect(manager.delete).not.toHaveBeenCalled();
    // exactly 5 is fine
    await service.replaceForEventTeam(EVENT, TEAM, ids.slice(0, 5));
    expect(manager.insert).toHaveBeenCalled();
  });

  describe('eventTeamIdsLedBy', () => {
    it('returns [] without further lookups when the user leads nothing', async () => {
      const { service, signups, users } = makeService();
      await expect(service.eventTeamIdsLedBy(U1)).resolves.toEqual([]);
      expect(users.exists).not.toHaveBeenCalled();
      expect(signups.find).not.toHaveBeenCalled();
    });

    it('returns only the led crews the user is still placed on (moved-off / cancelled ones drop out)', async () => {
      const { service, signups } = makeService({ rows: [{ eventTeamId: TEAM }, { eventTeamId: TEAM_B }] });
      signups.find.mockResolvedValue([{ id: 's1', eventTeamId: TEAM }]);
      await expect(service.eventTeamIdsLedBy(U1)).resolves.toEqual([TEAM]);
      const where = signups.find.mock.calls[0][0].where;
      expect(where.userId).toBe(U1);
      expect(where.status.type).toBe('not');
    });

    it('returns [] for a user who is not approved', async () => {
      const { service } = makeService({ rows: [{ eventTeamId: TEAM }], userApproved: false });
      await expect(service.eventTeamIdsLedBy(U1)).resolves.toEqual([]);
    });
  });
});

describe('EventTeamLeadsController', () => {
  it('delegates to the service', async () => {
    const teamLeads = {
      listForEventTeam: vi.fn().mockResolvedValue([{ userId: U1, name: 'A' }]),
      replaceForEventTeam: vi.fn().mockResolvedValue([]),
    };
    const controller = new EventTeamLeadsController(teamLeads as never);
    await controller.list(EVENT, TEAM);
    await controller.replace(EVENT, TEAM, { userIds: [U1] });
    expect(teamLeads.listForEventTeam).toHaveBeenCalledWith(EVENT, TEAM);
    expect(teamLeads.replaceForEventTeam).toHaveBeenCalledWith(EVENT, TEAM, [U1]);
  });
});

describe('ReplaceEventTeamLeadsDto', () => {
  const check = async (body: Record<string, unknown>) => validate(plainToInstance(ReplaceEventTeamLeadsDto, body));

  it('accepts uuid arrays up to 5, including an empty one', async () => {
    expect(await check({ userIds: [U1, U2] })).toHaveLength(0);
    expect(await check({ userIds: [] })).toHaveLength(0);
    expect(await check({ userIds: [U1, U2, U3, U1, U2] })).toHaveLength(0);
  });

  it('rejects missing, non-array, non-uuid and oversized values', async () => {
    expect((await check({})).length).toBeGreaterThan(0);
    expect((await check({ userIds: 'abc' })).length).toBeGreaterThan(0);
    expect((await check({ userIds: ['not-a-uuid'] })).length).toBeGreaterThan(0);
    expect((await check({ userIds: Array.from({ length: 6 }, () => U1) })).length).toBeGreaterThan(0);
  });
});
