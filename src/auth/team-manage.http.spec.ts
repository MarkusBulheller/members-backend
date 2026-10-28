import 'reflect-metadata';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { EventSignup } from '../events/event-signup.entity.js';
import { EventTeamLead } from '../events/event-team-lead.entity.js';
import { EventTeamLeadsController } from '../events/event-team-leads.controller.js';
import { EventTeamDummyDriversController } from '../events/event-team-dummy-drivers.controller.js';
import { EventTeamDummyDriversService } from '../events/event-team-dummy-drivers.service.js';
import { EventTeamStintsController } from '../events/event-team-stints.controller.js';
import { EventTeamStintsService } from '../events/event-team-stints.service.js';
import { EventTeam } from '../events/event-team.entity.js';
import { EventTeamsController } from '../events/event-teams.controller.js';
import { EventTeamsService } from '../events/event-teams.service.js';
import { EventsController } from '../events/events.controller.js';
import { EventsService } from '../events/events.service.js';
import { EventGuestSignupsService } from '../events/event-guest-signups.service.js';
import { FollowLinkController } from '../events/follow/follow-link.controller.js';
import { FollowLinkService } from '../events/follow/follow-link.service.js';
import { TeamLeadsService } from './team-leads.service.js';
import { TeamManageGuard } from './team-manage.guard.js';
import { TeamManagePolicy } from './team-manage.policy.js';

/** End-to-end through Nest's real guard + pipe pipeline (only the JWT guard and the services/repositories are faked). */

const EVENT = '11111111-1111-4111-8111-111111111111';
const RED = '22222222-2222-4222-8222-222222222222'; // iRacing team 100 (stored negative on purpose)
const BLUE = '33333333-3333-4333-8333-333333333333'; // iRacing team 100 too: the second crew of the SAME iRacing team
const SIGNUP_RED = '44444444-4444-4444-8444-444444444444';
const SIGNUP_BLUE = '55555555-5555-4555-8555-555555555555';
const SOLO = '66666666-6666-4666-8666-666666666666'; // crew without an iRacing team
const OTHER_EVENT = '77777777-7777-4777-8777-777777777777';
const RED_IN_OTHER_EVENT = '88888888-8888-4888-8888-888888888888'; // same iRacing team 100, another event
const LEAD_RED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const teams: Record<string, object> = {
  [RED]: { id: RED, eventId: EVENT, iracingTeamId: -100, name: 'Red', carId: null, timeslotId: null },
  [BLUE]: { id: BLUE, eventId: EVENT, iracingTeamId: 100, name: 'Blue', carId: null, timeslotId: null },
  [SOLO]: { id: SOLO, eventId: EVENT, iracingTeamId: null, name: 'Solo', carId: null, timeslotId: null },
  [RED_IN_OTHER_EVENT]: { id: RED_IN_OTHER_EVENT, eventId: OTHER_EVENT, iracingTeamId: 100, name: 'Red', carId: null, timeslotId: null },
};
const signups: Record<string, object> = {
  [SIGNUP_RED]: { id: SIGNUP_RED, eventId: EVENT, eventTeamId: RED, carClass: 'GT3', carId: null, secondaryCarClass: null, notes: null },
  [SIGNUP_BLUE]: { id: SIGNUP_BLUE, eventId: EVENT, eventTeamId: BLUE, carClass: 'GT3', carId: null, secondaryCarClass: null, notes: null },
};
const users: Record<string, { id: string; role: Role; status: UserStatus }> = {
  lead: { id: LEAD_RED, role: Role.MEMBER, status: UserStatus.APPROVED },
  member: { id: MEMBER, role: Role.MEMBER, status: UserStatus.APPROVED },
  admin: { id: ADMIN, role: Role.ADMIN, status: UserStatus.APPROVED },
};

/** "eventTeamId:userId" for every lead row. Mutated by tests that change the lead's situation. */
const leadRows = new Set<string>();
/** "eventTeamId:userId" -> status of the signup that user has on that crew. */
const placements = new Map<string, string>();
const resetWorld = () => {
  leadRows.clear();
  placements.clear();
  leadRows.add(`${RED}:${LEAD_RED}`);
  placements.set(`${RED}:${LEAD_RED}`, 'CONFIRMED');
};

describe('team lead permissions over HTTP', () => {
  let app: INestApplication;
  const stints = { create: vi.fn().mockResolvedValue({ ok: true }) };
  const teamsService = { update: vi.fn().mockResolvedValue({ ok: true }), create: vi.fn(), remove: vi.fn() };
  const eventsService = {
    adminUpdateSignup: vi.fn().mockResolvedValue({ ok: true }),
    assignSignupTeam: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const dummy = { create: vi.fn().mockResolvedValue({ ok: true }) };
  const follow = { get: vi.fn().mockResolvedValue({ ok: true }), update: vi.fn().mockResolvedValue({ ok: true }) };
  const teamLeads = {
    listForEventTeam: vi.fn().mockResolvedValue([]),
    replaceForEventTeam: vi.fn().mockResolvedValue([]),
  };

  beforeEach(resetWorld);

  beforeAll(async () => {
    resetWorld();
    const moduleRef = await Test.createTestingModule({
      controllers: [
        EventTeamStintsController,
        EventTeamsController,
        EventsController,
        EventTeamDummyDriversController,
        FollowLinkController,
        EventTeamLeadsController,
      ],
      providers: [
        TeamManagePolicy,
        TeamManageGuard,
        { provide: EventTeamStintsService, useValue: stints },
        { provide: EventTeamsService, useValue: teamsService },
        { provide: EventsService, useValue: eventsService },
        { provide: EventGuestSignupsService, useValue: {} },
        { provide: EventTeamDummyDriversService, useValue: dummy },
        { provide: FollowLinkService, useValue: follow },
        { provide: TeamLeadsService, useValue: teamLeads },
        { provide: getRepositoryToken(EventTeam), useValue: { findOne: async ({ where }: { where: { id: string } }) => teams[where.id] ?? null } },
        {
          provide: getRepositoryToken(EventSignup),
          useValue: {
            findOne: async ({ where }: { where: { id: string } }) => signups[where.id] ?? null,
            // "is this user on this crew with a non-CANCELLED signup" - evaluates the Not(CANCELLED) operator
            exists: async ({ where }: { where: { eventTeamId: string; userId: string; status: { value: string } } }) => {
              const status = placements.get(`${where.eventTeamId}:${where.userId}`);
              return status !== undefined && status !== where.status.value;
            },
          },
        },
        {
          provide: getRepositoryToken(EventTeamLead),
          useValue: {
            exists: async ({ where }: { where: { eventTeamId: string; userId: string } }) =>
              leadRows.has(`${where.eventTeamId}:${where.userId}`),
          },
        },
      ],
    })
      // Any other constructor dependency a controller grows (not relevant to permissions) is auto-mocked.
      .useMocker(() => ({}))
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const who = req.headers['x-test-user'];
          if (!who) return false;
          req.user = users[who];
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'post' | 'patch' | 'get' | 'put' | 'delete', url: string, who: string, body?: object) => {
    const req = request(app.getHttpServer())[method](url).set('x-test-user', who);
    return body ? req.send(body) : req;
  };

  const stintUrl = (team: string, event = EVENT) => `/events/${event}/teams/${team}/stints`;

  it('stints: admin and the lead of the crew may create; a member and another crew\'s lead may not', async () => {
    expect((await call('post', stintUrl(RED), 'admin', { durationMinutes: 60 })).status).toBe(201);
    expect((await call('post', stintUrl(RED), 'lead', { durationMinutes: 60 })).status).toBe(201);
    expect((await call('post', stintUrl(BLUE), 'lead', { durationMinutes: 60 })).status).toBe(403);
    expect((await call('post', stintUrl(RED), 'member', { durationMinutes: 60 })).status).toBe(403);
    expect((await call('post', `/events/${EVENT}/teams/not-a-uuid/stints`, 'lead', { durationMinutes: 60 })).status).toBe(403);
  });

  it('a lead of crew A cannot act on crew B of the same event, even on the same iRacing team', async () => {
    expect((await call('post', stintUrl(BLUE), 'lead', { durationMinutes: 60 })).status).toBe(403);
    expect((await call('get', `/events/${EVENT}/teams/${BLUE}/follow-link`, 'lead')).status).toBe(403);
    expect((await call('patch', `/events/${EVENT}/teams/${BLUE}`, 'lead', { refuelDurationSeconds: 30 })).status).toBe(403);
  });

  it('a lead cannot reach a crew of the same iRacing team in another event', async () => {
    expect((await call('post', stintUrl(RED_IN_OTHER_EVENT, OTHER_EVENT), 'lead', { durationMinutes: 60 })).status).toBe(403);
    // their own crew addressed through another event's URL is refused too (the team is not part of that event)
    expect((await call('post', stintUrl(RED, OTHER_EVENT), 'lead', { durationMinutes: 60 })).status).toBe(403);
  });

  it('a lead moved off the crew loses access immediately', async () => {
    expect((await call('post', stintUrl(RED), 'lead', { durationMinutes: 60 })).status).toBe(201);
    placements.delete(`${RED}:${LEAD_RED}`);
    expect((await call('post', stintUrl(RED), 'lead', { durationMinutes: 60 })).status).toBe(403);
    expect((await call('post', stintUrl(RED), 'admin', { durationMinutes: 60 })).status).toBe(201);
  });

  it('a lead with a CANCELLED signup is denied', async () => {
    placements.set(`${RED}:${LEAD_RED}`, 'CANCELLED');
    expect((await call('post', stintUrl(RED), 'lead', { durationMinutes: 60 })).status).toBe(403);
  });

  it('a crew without an iRacing team can have a lead', async () => {
    expect((await call('post', stintUrl(SOLO), 'lead', { durationMinutes: 60 })).status).toBe(403);
    leadRows.add(`${SOLO}:${LEAD_RED}`);
    placements.set(`${SOLO}:${LEAD_RED}`, 'CONFIRMED');
    expect((await call('post', stintUrl(SOLO), 'lead', { durationMinutes: 60 })).status).toBe(201);
  });

  it('lead management is admin-only and validated (max 5 UUIDs)', async () => {
    const url = `/events/${EVENT}/teams/${RED}/leads`;
    expect((await call('get', url, 'admin')).status).toBe(200);
    expect((await call('get', url, 'lead')).status).toBe(403);
    expect((await call('put', url, 'lead', { userIds: [LEAD_RED] })).status).toBe(403);
    expect((await call('put', url, 'member', { userIds: [LEAD_RED] })).status).toBe(403);
    expect(teamLeads.replaceForEventTeam).not.toHaveBeenCalled();

    expect((await call('put', url, 'admin', { userIds: [LEAD_RED] })).status).toBe(200);
    expect(teamLeads.replaceForEventTeam).toHaveBeenCalledWith(EVENT, RED, [LEAD_RED]);
    expect((await call('put', url, 'admin', { userIds: [] })).status).toBe(200);
    expect((await call('put', url, 'admin', { userIds: Array.from({ length: 6 }, () => LEAD_RED) })).status).toBe(400);
    expect((await call('put', url, 'admin', { userIds: ['nope'] })).status).toBe(400);
    expect((await call('put', url, 'admin', {})).status).toBe(400);
    expect((await call('get', `/events/${EVENT}/teams/not-a-uuid/leads`, 'admin')).status).toBe(400);
  });

  it('guest drivers and the follow link follow the same rule', async () => {
    expect((await call('get', `/events/${EVENT}/teams/${RED}/follow-link`, 'lead')).status).toBe(200);
    expect((await call('get', `/events/${EVENT}/teams/${BLUE}/follow-link`, 'lead')).status).toBe(403);
    expect((await call('get', `/events/${EVENT}/teams/${RED}/follow-link`, 'member')).status).toBe(403);
    expect((await call('post', `/events/${EVENT}/teams/${RED}/dummy-drivers`, 'member', { name: 'X' })).status).toBe(403);
  });

  it('team PATCH: a lead may change planning settings only', async () => {
    const url = `/events/${EVENT}/teams/${RED}`;
    expect((await call('patch', url, 'lead', { refuelDurationSeconds: 30 })).status).toBe(200);
    expect((await call('patch', url, 'lead', { name: 'Hijacked' })).status).toBe(403);
    expect((await call('patch', url, 'lead', { iracingTeamId: 200 })).status).toBe(403);
    expect((await call('patch', `/events/${EVENT}/teams/${BLUE}`, 'lead', { refuelDurationSeconds: 30 })).status).toBe(403);
    expect((await call('patch', url, 'admin', { name: 'Renamed' })).status).toBe(200);
  });

  it('team create / delete and event edits stay admin-only for leads', async () => {
    expect((await call('post', `/events/${EVENT}/teams`, 'lead', { name: 'New' })).status).toBe(403);
    expect((await call('delete', `/events/${EVENT}/teams/${RED}`, 'lead')).status).toBe(403);
    expect((await call('patch', `/events/${EVENT}`, 'lead', {})).status).toBe(403);
    expect((await call('post', `/events`, 'lead', {})).status).toBe(403);
  });

  it('signup details: a lead may edit availability of a signup on their crew, not another crew\'s, not the car class', async () => {
    const own = `/events/${EVENT}/signups/${SIGNUP_RED}/details`;
    const other = `/events/${EVENT}/signups/${SIGNUP_BLUE}/details`;
    expect((await call('patch', own, 'lead', { availableHours: [] })).status).toBe(200);
    expect((await call('patch', other, 'lead', { availableHours: [] })).status).toBe(403);
    expect((await call('patch', own, 'lead', { carClass: 'LMP2' })).status).toBe(403);
    expect((await call('patch', own, 'member', { availableHours: [] })).status).toBe(403);
    expect((await call('patch', own, 'admin', { carClass: 'LMP2' })).status).toBe(200);
  });

  it('moving a driver between teams stays admin-only', async () => {
    const url = `/events/${EVENT}/signups/${SIGNUP_RED}/team`;
    expect((await call('patch', url, 'lead', { eventTeamId: RED })).status).toBe(403);
    expect(eventsService.assignSignupTeam).not.toHaveBeenCalled();
  });
});
