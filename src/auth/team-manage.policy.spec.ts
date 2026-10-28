import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { TEAM_MANAGE_KEY, TeamManage, TeamManageGuard } from './team-manage.guard.js';
import { TeamManagePolicy, type TeamManageRequest } from './team-manage.policy.js';

const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER_EVENT = '99999999-9999-4999-8999-999999999999';
const TEAM = '22222222-2222-4222-8222-222222222222';
const TEAM_NO_IRACING = '33333333-3333-4333-8333-333333333333';
const TEAM_B = '66666666-6666-4666-8666-666666666666'; // second crew of the same event and the same iRacing team
const TEAM_OTHER_EVENT = '77777777-7777-4777-8777-777777777777'; // same iRacing team, another event
const SIGNUP = '44444444-4444-4444-8444-444444444444';
const SIGNUP_UNASSIGNED = '55555555-5555-4555-8555-555555555555';
const LEAD_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface World {
  teams?: Record<string, Record<string, unknown>>;
  signups?: Record<string, Record<string, unknown>>;
  /** "eventTeamId:userId" pairs that are leads. */
  leads?: string[];
  /** Placements: "eventTeamId:userId" -> signup status ("not placed" when absent). */
  placed?: Record<string, string>;
}

function makePolicy(world: World = {}) {
  const teams = world.teams ?? {
    [TEAM]: { id: TEAM, eventId: EVENT, iracingTeamId: 100, name: 'Red', carId: null, timeslotId: null },
    [TEAM_B]: { id: TEAM_B, eventId: EVENT, iracingTeamId: 100, name: 'Red B', carId: null, timeslotId: null },
    [TEAM_OTHER_EVENT]: { id: TEAM_OTHER_EVENT, eventId: OTHER_EVENT, iracingTeamId: 100, name: 'Red', carId: null, timeslotId: null },
    [TEAM_NO_IRACING]: { id: TEAM_NO_IRACING, eventId: EVENT, iracingTeamId: null, name: 'Blue', carId: null, timeslotId: null },
  };
  const signups = world.signups ?? {
    [SIGNUP]: { id: SIGNUP, eventId: EVENT, eventTeamId: TEAM, carId: null, carClass: 'GT3', secondaryCarClass: null, notes: null },
    [SIGNUP_UNASSIGNED]: { id: SIGNUP_UNASSIGNED, eventId: EVENT, eventTeamId: null, carId: null, carClass: null, secondaryCarClass: null, notes: null },
  };
  const leadSet = new Set(world.leads ?? [`${TEAM}:${LEAD_USER}`]);
  const placed = world.placed ?? { [`${TEAM}:${LEAD_USER}`]: 'CONFIRMED' };
  const teamsRepo = { findOne: vi.fn(async ({ where }: { where: { id: string } }) => teams[where.id] ?? null) };
  const signupsRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) => signups[where.id] ?? null),
    // The policy asks "is this user on this crew with a non-CANCELLED signup" - evaluate the Not(CANCELLED) operator.
    exists: vi.fn(async ({ where }: { where: { eventTeamId: string; userId: string; status: { value: string } } }) => {
      const status = placed[`${where.eventTeamId}:${where.userId}`];
      return status !== undefined && status !== where.status.value;
    }),
  };
  const leadsRepo = {
    exists: vi.fn(async ({ where }: { where: { eventTeamId: string; userId: string } }) =>
      leadSet.has(`${where.eventTeamId}:${where.userId}`),
    ),
  };
  const policy = new TeamManagePolicy(teamsRepo as never, signupsRepo as never, leadsRepo as never);
  return { policy, teamsRepo, signupsRepo, leadsRepo };
}

const user = (id: string, role = Role.MEMBER, status = UserStatus.APPROVED) => ({ id, role, status });

function request(u: ReturnType<typeof user> | null, params: Record<string, string>, body?: unknown): TeamManageRequest {
  return { user: u, params, body };
}

const teamReq = (u: ReturnType<typeof user> | null, teamId = TEAM, eventId = EVENT, body?: unknown) =>
  request(u, { eventId, teamId }, body);

describe('TeamManagePolicy', () => {
  it('lets an admin through without any lookup', async () => {
    const { policy, teamsRepo } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user('x', Role.ADMIN), 'not-a-uuid'))).resolves.toBeUndefined();
    expect(teamsRepo.findOne).not.toHaveBeenCalled();
  });

  it('lets the lead of the addressed crew through', async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER)))).resolves.toBeUndefined();
  });

  it('refuses the lead of another crew of the same event, even on the same iRacing team', async () => {
    const { policy } = makePolicy({
      leads: [`${TEAM_B}:${LEAD_USER}`],
      placed: { [`${TEAM_B}:${LEAD_USER}`]: 'CONFIRMED' },
    });
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM))).rejects.toThrow(ForbiddenException);
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM_B))).resolves.toBeUndefined();
  });

  it("refuses the lead of a crew when addressing the same iRacing team's crew in another event", async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM_OTHER_EVENT, OTHER_EVENT))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses a lead who was moved off the crew (no placement any more)', async () => {
    const { policy } = makePolicy({ placed: {} });
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER)))).rejects.toThrow(/admin or a lead/);
  });

  it('refuses a lead placed on another crew than the one they lead', async () => {
    const { policy } = makePolicy({ placed: { [`${TEAM_B}:${LEAD_USER}`]: 'CONFIRMED' } });
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER)))).rejects.toThrow(ForbiddenException);
  });

  it('refuses a lead whose signup is CANCELLED, allows a WAITLISTED one that is still placed', async () => {
    const cancelled = makePolicy({ placed: { [`${TEAM}:${LEAD_USER}`]: 'CANCELLED' } });
    await expect(cancelled.policy.assertCanManage(teamReq(user(LEAD_USER)))).rejects.toThrow(ForbiddenException);
    const waitlisted = makePolicy({ placed: { [`${TEAM}:${LEAD_USER}`]: 'WAITLISTED' } });
    await expect(waitlisted.policy.assertCanManage(teamReq(user(LEAD_USER)))).resolves.toBeUndefined();
  });

  it('refuses a placed driver who is not a lead', async () => {
    const { policy } = makePolicy({ leads: [], placed: { [`${TEAM}:${OTHER_USER}`]: 'CONFIRMED' } });
    await expect(policy.assertCanManage(teamReq(user(OTHER_USER)))).rejects.toThrow(ForbiddenException);
  });

  it('refuses a user who is not in the lead table', async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user(OTHER_USER)))).rejects.toThrow(ForbiddenException);
  });

  it('refuses a plain member', async () => {
    const { policy } = makePolicy({ leads: [] });
    await expect(policy.assertCanManage(teamReq(user(OTHER_USER)))).rejects.toThrow(/admin or a lead/);
  });

  it('refuses a missing user and an unapproved lead', async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(null))).rejects.toThrow(ForbiddenException);
    for (const status of [UserStatus.PENDING, UserStatus.SUSPENDED, UserStatus.REJECTED]) {
      await expect(policy.assertCanManage(teamReq(user(LEAD_USER, Role.MEMBER, status)))).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('the iRacing team plays no role: a crew without iracingTeamId can have a lead', async () => {
    const { policy } = makePolicy({
      leads: [`${TEAM_NO_IRACING}:${LEAD_USER}`],
      placed: { [`${TEAM_NO_IRACING}:${LEAD_USER}`]: 'CONFIRMED' },
    });
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM_NO_IRACING))).resolves.toBeUndefined();
  });

  it('a crew without iracingTeamId has no lead unless one was chosen', async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM_NO_IRACING))).rejects.toThrow(ForbiddenException);
  });

  it('refuses unknown / malformed team ids and a team that belongs to another event', async () => {
    const { policy } = makePolicy();
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), '88888888-8888-4888-8888-888888888889'))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), 'nope'))).rejects.toThrow(ForbiddenException);
    await expect(policy.assertCanManage(teamReq(user(LEAD_USER), TEAM, OTHER_EVENT))).rejects.toThrow(ForbiddenException);
  });

  describe('resolver modes', () => {
    it('teamParam is the default', async () => {
      const { policy } = makePolicy();
      await expect(policy.assertCanManage(teamReq(user(LEAD_USER)), {})).resolves.toBeUndefined();
      await expect(policy.assertCanManage(teamReq(user(LEAD_USER)), { from: 'teamParam' })).resolves.toBeUndefined();
    });

    it('signupParam resolves the team the signup is on', async () => {
      const { policy } = makePolicy();
      const req = request(user(LEAD_USER), { id: EVENT, signupId: SIGNUP });
      await expect(policy.assertCanManage(req, { from: 'signupParam' })).resolves.toBeUndefined();
    });

    it('signupParam refuses a signup on no team, an unknown signup, a bad id and another event', async () => {
      const { policy } = makePolicy();
      for (const params of [
        { id: EVENT, signupId: SIGNUP_UNASSIGNED },
        { id: EVENT, signupId: '88888888-8888-4888-8888-888888888888' },
        { id: EVENT, signupId: 'nope' },
        { id: OTHER_EVENT, signupId: SIGNUP },
      ]) {
        await expect(policy.assertCanManage(request(user(LEAD_USER), params), { from: 'signupParam' })).rejects.toThrow(
          ForbiddenException,
        );
      }
    });

    it('signupParam refuses a lead of another crew than the signup is on', async () => {
      const { policy } = makePolicy({
        leads: [`${TEAM_B}:${LEAD_USER}`],
        placed: { [`${TEAM_B}:${LEAD_USER}`]: 'CONFIRMED' },
      });
      const req = request(user(LEAD_USER), { id: EVENT, signupId: SIGNUP });
      await expect(policy.assertCanManage(req, { from: 'signupParam' })).rejects.toThrow(ForbiddenException);
    });

    it('body resolves req.body.eventTeamId', async () => {
      const { policy } = makePolicy();
      const ok = request(user(LEAD_USER), { id: EVENT }, { eventTeamId: TEAM });
      await expect(policy.assertCanManage(ok, { from: 'body' })).resolves.toBeUndefined();
      for (const body of [{ eventTeamId: null }, {}, { eventTeamId: TEAM_NO_IRACING }, { eventTeamId: 5 }]) {
        await expect(
          policy.assertCanManage(request(user(LEAD_USER), { id: EVENT }, body), { from: 'body' }),
        ).rejects.toThrow(ForbiddenException);
      }
    });
  });

  describe('field restrictions for leads', () => {
    it('team: planning settings pass; name/car/iRacing team/timeslot are refused', async () => {
      const { policy } = makePolicy();
      const patch = (body: unknown) => policy.assertCanManage(teamReq(user(LEAD_USER), TEAM, EVENT, body), { restrict: 'team' });
      await expect(patch({ refuelDurationSeconds: 30, lapTimeDrySeconds: 100.5, simStartTimeOfDay: '12:00' })).resolves.toBeUndefined();
      await expect(patch({ name: 'Renamed' })).rejects.toThrow(/name/);
      await expect(patch({ carId: '66666666-6666-4666-8666-666666666666' })).rejects.toThrow(/carId/);
      await expect(patch({ iracingTeamId: 200 })).rejects.toThrow(/iracingTeamId/);
      await expect(patch({ timeslotId: '66666666-6666-4666-8666-666666666666' })).rejects.toThrow(/timeslotId/);
      await expect(patch({ refuelDurationSeconds: 30, name: 'x', timeslotId: 'y' })).rejects.toThrow(/name, timeslotId/);
    });

    it('team: an unchanged echo of an admin-only field is tolerated', async () => {
      const { policy } = makePolicy();
      const patch = (body: unknown) => policy.assertCanManage(teamReq(user(LEAD_USER), TEAM, EVENT, body), { restrict: 'team' });
      await expect(patch({ name: 'Red', carId: null, iracingTeamId: 100, timeslotId: null })).resolves.toBeUndefined();
    });

    it('team: admins are never restricted', async () => {
      const { policy } = makePolicy();
      await expect(
        policy.assertCanManage(teamReq(user('x', Role.ADMIN), TEAM, EVENT, { name: 'x', iracingTeamId: 5 }), { restrict: 'team' }),
      ).resolves.toBeUndefined();
    });

    it('signup: start times + availability pass; car, classes and notes are refused', async () => {
      const { policy } = makePolicy();
      const patch = (body: unknown) =>
        policy.assertCanManage(request(user(LEAD_USER), { id: EVENT, signupId: SIGNUP }, body), {
          from: 'signupParam',
          restrict: 'signup',
        });
      await expect(patch({ availableHours: [], timeslotIds: [], timeslotPreference: null })).resolves.toBeUndefined();
      await expect(patch({ carClass: 'LMP2' })).rejects.toThrow(/carClass/);
      await expect(patch({ secondaryCarClass: 'GT4' })).rejects.toThrow(/secondaryCarClass/);
      await expect(patch({ carId: '66666666-6666-4666-8666-666666666666' })).rejects.toThrow(/carId/);
      await expect(patch({ notes: 'hi' })).rejects.toThrow(/notes/);
    });

    it('signup: the whole form echoed back unchanged is tolerated (null and empty are the same)', async () => {
      const { policy } = makePolicy();
      const body = { carClass: 'GT3', secondaryCarClass: null, carId: null, timeslotIds: [], availableHours: [] };
      await expect(
        policy.assertCanManage(request(user(LEAD_USER), { id: EVENT, signupId: SIGNUP }, body), {
          from: 'signupParam',
          restrict: 'signup',
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('memoises lookups per request but not across requests', async () => {
    const { policy, teamsRepo, leadsRepo, signupsRepo } = makePolicy();
    const req = teamReq(user(LEAD_USER), TEAM, EVENT, {});
    await policy.assertCanManage(req, { restrict: 'team' });
    await policy.assertCanManage(req, { restrict: 'team' });
    expect(teamsRepo.findOne).toHaveBeenCalledTimes(1);
    expect(leadsRepo.exists).toHaveBeenCalledTimes(1);
    expect(signupsRepo.exists).toHaveBeenCalledTimes(1);
    await policy.assertCanManage(teamReq(user(LEAD_USER)));
    expect(teamsRepo.findOne).toHaveBeenCalledTimes(2);
    expect(leadsRepo.exists).toHaveBeenCalledTimes(2);
    expect(signupsRepo.exists).toHaveBeenCalledTimes(2);
  });
});

describe('TeamManageGuard / @TeamManage()', () => {
  class Sample {
    @TeamManage()
    plain() {}

    @TeamManage({ from: 'signupParam', restrict: 'signup' })
    signup() {}

    undecorated() {}
  }

  const contextFor = (handler: () => void, req: TeamManageRequest) =>
    ({
      getHandler: () => handler,
      getClass: () => Sample,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('stores the options (defaulting to teamParam) and registers the guard', () => {
    expect(Reflect.getMetadata(TEAM_MANAGE_KEY, Sample.prototype.plain)).toEqual({ from: 'teamParam' });
    expect(Reflect.getMetadata(TEAM_MANAGE_KEY, Sample.prototype.signup)).toEqual({ from: 'signupParam', restrict: 'signup' });
    expect(Reflect.getMetadata('__guards__', Sample.prototype.plain)).toEqual([TeamManageGuard]);
  });

  it('passes the stored options and the request to the policy', async () => {
    const assertCanManage = vi.fn().mockResolvedValue(undefined);
    const guard = new TeamManageGuard(new Reflector(), { assertCanManage } as never);
    const req = request(user(LEAD_USER), { id: EVENT, signupId: SIGNUP });
    await expect(guard.canActivate(contextFor(Sample.prototype.signup, req))).resolves.toBe(true);
    expect(assertCanManage).toHaveBeenCalledWith(req, { from: 'signupParam', restrict: 'signup' });
  });

  it('propagates the policy refusal', async () => {
    const assertCanManage = vi.fn().mockRejectedValue(new ForbiddenException('nope'));
    const guard = new TeamManageGuard(new Reflector(), { assertCanManage } as never);
    await expect(guard.canActivate(contextFor(Sample.prototype.plain, request(null, {})))).rejects.toThrow(ForbiddenException);
  });

  it('denies by default when the guard runs on a handler without @TeamManage()', async () => {
    const assertCanManage = vi.fn();
    const guard = new TeamManageGuard(new Reflector(), { assertCanManage } as never);
    await expect(guard.canActivate(contextFor(Sample.prototype.undecorated, request(user('x', Role.ADMIN), {})))).rejects.toThrow(
      ForbiddenException,
    );
    expect(assertCanManage).not.toHaveBeenCalled();
  });
});
