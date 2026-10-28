import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { EventsModule } from '../events/events.module.js';
import { TEAM_MANAGE_KEY, TeamManageGuard } from './team-manage.guard.js';
import type { TeamManageOptions } from './team-manage.policy.js';

/**
 * Permission map of every route in the events module (including the per-crew team-lead admin routes).
 * The point of this table is to fail LOUDLY when a route is added without a deliberate decision:
 * every handler must be listed here with how it is guarded, and the listed kind must be what the
 * decorators really say. Adding a route => add a row (and think about who may call it).
 *
 *  PUBLIC  - no JWT at all (anonymous)
 *  MEMBER  - any approved member (JwtAuthGuard only)
 *  ADMIN   - RolesGuard + @Roles(ADMIN) only
 *  LEAD    - @TeamManage(): admin OR a lead of the addressed event team who is still placed on it
 */
type Kind = 'PUBLIC' | 'MEMBER' | 'ADMIN' | { lead: TeamManageOptions };

const lead = (options: TeamManageOptions = { from: 'teamParam' }): Kind => ({ lead: options });

const EXPECTED: Record<string, Kind> = {
  // --- events ---------------------------------------------------------------------------
  'EventsController.findAll': 'MEMBER',
  'EventsController.findMyUpcomingStints': 'MEMBER',
  'EventsController.findOne': 'MEMBER',
  'EventsController.listGuestSignups': 'ADMIN',
  'EventsController.cancelGuestSignup': 'ADMIN',
  'EventsController.placeGuestSignupOnTeam': 'ADMIN',
  'EventsController.create': 'ADMIN',
  'EventsController.update': 'ADMIN',
  'EventsController.remove': 'ADMIN',
  'EventsController.signup': 'MEMBER',
  'EventsController.cancelSignup': 'MEMBER',
  'EventsController.addSignup': 'ADMIN',
  'EventsController.overrideSignup': 'ADMIN',
  // Lead: start times + availability of a signup that is ON a team they lead (never car/class/notes).
  'EventsController.updateSignupDetails': lead({ from: 'signupParam', restrict: 'signup' }),
  // Moving drivers between teams stays admin-only.
  'EventsController.assignSignupTeam': 'ADMIN',
  'EventsController.deleteSignup': 'ADMIN',
  'PublicEventsController.findPublicUpcoming': 'PUBLIC',
  'ReadinessController.getReadiness': 'MEMBER',

  // --- event teams ----------------------------------------------------------------------
  'EventTeamsController.findAll': 'MEMBER',
  'EventTeamsController.findOne': 'MEMBER',
  // Team CRUD stays admin-only, except PATCH which a lead may use for the planning settings only.
  'EventTeamsController.create': 'ADMIN',
  'EventTeamsController.update': lead({ from: 'teamParam', restrict: 'team' }),
  'EventTeamsController.remove': 'ADMIN',

  // --- team plan: stints / driver settings / guest drivers ------------------------------
  'EventTeamStintsController.findAll': 'MEMBER',
  'EventTeamStintsController.create': lead(),
  'EventTeamStintsController.update': lead(),
  'EventTeamStintsController.move': lead(),
  'EventTeamStintsController.moveTo': lead(),
  'EventTeamStintsController.toggleStartNow': lead(),
  'EventTeamStintsController.remove': lead(),
  'EventTeamDriverSettingsController.findAll': 'MEMBER',
  'EventTeamDriverSettingsController.upsert': lead(),
  'EventTeamDummyDriversController.findAll': 'MEMBER',
  'EventTeamDummyDriversController.create': lead(),
  'EventTeamDummyDriversController.update': lead(),
  'EventTeamDummyDriversController.remove': lead(),

  // --- live plan stream (read-only) and the follow link ---------------------------------
  'TeamPlanStreamController.stream': 'MEMBER',
  // Discord thread of a team: admin-only (not part of the team-lead allow-list).
  'EventTeamThreadController.get': 'ADMIN',
  'EventTeamThreadController.ensure': 'ADMIN',
  'EventTeamThreadController.postPlanSummary': 'ADMIN',
  'FollowLinkController.get': lead(),
  'FollowLinkController.update': lead(),
  'PublicFollowController.getState': 'PUBLIC',
  'PublicFollowController.stream': 'PUBLIC',

  // --- leads of one event crew: choosing them is admin only (a lead can't appoint leads) ---
  'EventTeamLeadsController.list': 'ADMIN',
  'EventTeamLeadsController.replace': 'ADMIN',
};

type Ctor = (new (...args: never[]) => unknown) & { prototype: Record<string, unknown> };

function controllersUnderTest(): Ctor[] {
  return (Reflect.getMetadata('controllers', EventsModule) ?? []) as Ctor[];
}

function routeNames(controller: Ctor): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      typeof controller.prototype[name] === 'function' &&
      Reflect.hasMetadata(PATH_METADATA, controller.prototype[name] as object),
  );
}

function classify(controller: Ctor, name: string): Kind | string {
  const handler = controller.prototype[name] as object;
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
  ];
  const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller)) as
    | Role[]
    | undefined;
  const teamManage = Reflect.getMetadata(TEAM_MANAGE_KEY, handler) as TeamManageOptions | undefined;

  if (!guards.includes(JwtAuthGuard)) return 'PUBLIC';
  if (teamManage) {
    if (!guards.includes(TeamManageGuard)) return 'BROKEN: TEAM_MANAGE metadata without TeamManageGuard';
    if (roles?.length) return 'BROKEN: TeamManage combined with @Roles';
    return { lead: teamManage };
  }
  if (guards.includes(TeamManageGuard)) return 'BROKEN: TeamManageGuard without @TeamManage() options';
  if (roles?.length) {
    if (!guards.includes(RolesGuard)) return 'BROKEN: @Roles without RolesGuard (the roles are NOT enforced)';
    return roles.length === 1 && roles[0] === Role.ADMIN ? 'ADMIN' : `BROKEN: unexpected roles ${roles.join(',')}`;
  }
  return 'MEMBER';
}

describe('route permission map (events module, incl. the team-lead admin routes)', () => {
  const actual: Record<string, Kind | string> = {};
  for (const controller of controllersUnderTest()) {
    for (const name of routeNames(controller)) {
      actual[`${controller.name}.${name}`] = classify(controller, name);
    }
  }

  it('lists every route and nothing else (a new route must be added to the table deliberately)', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s is guarded as intended', (route, expected) => {
    expect(actual[route]).toEqual(expected);
  });

  it('only the documented routes are open to team leads', () => {
    const open = Object.entries(actual)
      .filter(([, kind]) => typeof kind === 'object')
      .map(([route]) => route)
      .sort();
    expect(open).toEqual(
      [
        'EventsController.updateSignupDetails',
        'EventTeamsController.update',
        'EventTeamStintsController.create',
        'EventTeamStintsController.update',
        'EventTeamStintsController.move',
        'EventTeamStintsController.moveTo',
        'EventTeamStintsController.toggleStartNow',
        'EventTeamStintsController.remove',
        'EventTeamDriverSettingsController.upsert',
        'EventTeamDummyDriversController.create',
        'EventTeamDummyDriversController.update',
        'EventTeamDummyDriversController.remove',
        'FollowLinkController.get',
        'FollowLinkController.update',
      ].sort(),
    );
  });

  it('has no broken guard combinations', () => {
    const broken = Object.entries(actual).filter(([, kind]) => typeof kind === 'string' && kind.startsWith('BROKEN'));
    expect(broken).toEqual([]);
  });

  it('every route of the team plan controllers addresses a team through the :teamId URL param', () => {
    const planControllers = [
      'EventTeamStintsController',
      'EventTeamDriverSettingsController',
      'EventTeamDummyDriversController',
      'FollowLinkController',
    ];
    for (const controller of controllersUnderTest().filter((c) => planControllers.includes(c.name))) {
      expect(String(Reflect.getMetadata(PATH_METADATA, controller))).toContain(':teamId');
    }
  });

  it('exercises the HTTP method metadata (sanity: routes are real handlers)', () => {
    const [controller] = controllersUnderTest();
    const some = routeNames(controller)[0];
    expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype[some] as object)).toBeDefined();
  });
});
