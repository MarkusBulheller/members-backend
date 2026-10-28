import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID as validatorIsUUID } from 'class-validator';
import { Not, Repository } from 'typeorm';
import { Role } from '../common/enums/role.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { EventSignup } from '../events/event-signup.entity.js';
import { EventTeamLead } from '../events/event-team-lead.entity.js';
import { EventTeam } from '../events/event-team.entity.js';
import type { User } from '../users/user.entity.js';

/** Where the guard finds the event team a request is about:
 * - `teamParam`   - `:teamId` in the URL (`/events/:eventId/teams/:teamId/...`), the default;
 * - `signupParam` - `:signupId` in the URL: the team the signup is currently ON;
 * - `body`        - `eventTeamId` in the request body (routes that assign a team). */
export type TeamManageFrom = 'teamParam' | 'signupParam' | 'body';

/** Extra field-level limits a lead (non-admin) is held to on top of "may act on this team":
 * - `team`   - PATCH team: only the planning settings; name / car / iRacing team / timeslot stay admin-only;
 * - `signup` - PATCH signup details: only start times + availability; car, classes and notes stay admin-only. */
export type TeamManageRestrict = 'team' | 'signup';

export interface TeamManageOptions {
  from?: TeamManageFrom;
  restrict?: TeamManageRestrict;
}

/** The slice of an Express request the policy reads. */
export interface TeamManageRequest {
  user?: Pick<User, 'id' | 'role' | 'status'> | null;
  params?: Record<string, string | undefined>;
  body?: unknown;
}

/** EventTeam columns only an admin may change (a lead plans the race, they don't re-shape the crew). */
export const TEAM_ADMIN_ONLY_FIELDS = ['name', 'carId', 'iracingTeamId', 'timeslotId'] as const;
/** EventSignup columns only an admin may change on a signup (leads: start times + availability only). */
export const SIGNUP_ADMIN_ONLY_FIELDS = ['carId', 'carClass', 'secondaryCarClass', 'notes'] as const;

const isUUID = (value: unknown): value is string => typeof value === 'string' && validatorIsUUID(value);

const DENIED = 'Only an admin or a lead of this team can do that';

/** Collapses undefined / null / '' to null so an "echoed" unchanged value compares equal. */
function norm(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * Who may manage (plan) an event team: ADMIN always; otherwise an APPROVED user who is a lead of
 * THAT event team (one crew of one event) AND is currently placed on it (has a non-cancelled
 * signup with eventTeamId = that team). A lead moved off the crew or whose signup was cancelled
 * is denied immediately. Everything else is denied: a missing/invalid id, a team of another
 * event, another crew's lead, a plain member. The iRacing team of the crew plays no role.
 * Lookups are memoised per request object only (no long-lived cache), so a lead change or a
 * driver move takes effect on the very next request.
 */
@Injectable()
export class TeamManagePolicy {
  private readonly perRequest = new WeakMap<object, Map<string, Promise<unknown>>>();

  constructor(
    @InjectRepository(EventTeam) private readonly teams: Repository<EventTeam>,
    @InjectRepository(EventSignup) private readonly signups: Repository<EventSignup>,
    @InjectRepository(EventTeamLead) private readonly leads: Repository<EventTeamLead>,
  ) {}

  /** Throws a 403 ForbiddenException unless the request's user may manage the addressed team. */
  async assertCanManage(request: TeamManageRequest, options: TeamManageOptions = {}): Promise<void> {
    const user = request.user;
    if (!user) throw new ForbiddenException(DENIED);
    if (user.role === Role.ADMIN) return;
    if (user.status !== UserStatus.APPROVED) throw new ForbiddenException(DENIED);

    const team = await this.resolveTeam(request, options.from ?? 'teamParam');
    if (!team) throw new ForbiddenException(DENIED);
    const isLead = await this.cached(request, `lead:${team.id}:${user.id}`, () =>
      this.leads.exists({ where: { eventTeamId: team.id, userId: user.id } }),
    );
    if (!isLead) throw new ForbiddenException(DENIED);
    const isPlaced = await this.cached(request, `placed:${team.id}:${user.id}`, () =>
      this.signups.exists({
        where: { eventTeamId: team.id, userId: user.id, status: Not(SignupStatus.CANCELLED) },
      }),
    );
    if (!isPlaced) throw new ForbiddenException(DENIED);

    if (options.restrict === 'team') this.assertTeamBodyAllowed(request.body, team);
    if (options.restrict === 'signup') await this.assertSignupBodyAllowed(request);
  }

  /** The event team a request addresses, or null when it can't be resolved (-> deny). */
  private async resolveTeam(request: TeamManageRequest, from: TeamManageFrom): Promise<EventTeam | null> {
    const params = request.params ?? {};
    // The event id in the URL (`:eventId`, or `:id` on /events/:id/signups/...), when present,
    // must be the event the team really belongs to.
    const urlEventId = params.eventId ?? params.id;

    let teamId: unknown;
    if (from === 'teamParam') {
      teamId = params.teamId;
    } else if (from === 'signupParam') {
      const signupId = params.signupId;
      if (!isUUID(signupId)) return null;
      const signup = await this.findSignup(request, signupId);
      if (!signup) return null;
      if (urlEventId && signup.eventId !== urlEventId) return null;
      teamId = signup.eventTeamId;
    } else {
      teamId = (request.body as { eventTeamId?: unknown } | undefined)?.eventTeamId;
    }

    if (typeof teamId !== 'string' || !isUUID(teamId)) return null;
    const team = await this.cached(request, `team:${teamId}`, () => this.teams.findOne({ where: { id: teamId } }));
    if (!team) return null;
    if (urlEventId && team.eventId !== urlEventId) return null;
    return team;
  }

  private findSignup(request: TeamManageRequest, signupId: string): Promise<EventSignup | null> {
    return this.cached(request, `signup:${signupId}`, () => this.signups.findOne({ where: { id: signupId } }));
  }

  /** A lead may only touch the planning settings; an admin-only field is rejected unless it is an
   * unchanged echo of the stored value (so a form that posts the whole team back still works). */
  private assertTeamBodyAllowed(body: unknown, team: EventTeam): void {
    const payload = (body ?? {}) as Record<string, unknown>;
    const changed = TEAM_ADMIN_ONLY_FIELDS.filter(
      (field) => payload[field] !== undefined && norm(payload[field]) !== norm(team[field]),
    );
    if (changed.length > 0) {
      throw new ForbiddenException(`Only an admin can change: ${changed.join(', ')}`);
    }
  }

  private async assertSignupBodyAllowed(request: TeamManageRequest): Promise<void> {
    const signupId = request.params?.signupId;
    if (!isUUID(signupId)) throw new ForbiddenException(DENIED);
    const signup = await this.findSignup(request, signupId);
    if (!signup) throw new ForbiddenException(DENIED);
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const changed = SIGNUP_ADMIN_ONLY_FIELDS.filter(
      (field) => payload[field] !== undefined && norm(payload[field]) !== norm(signup[field]),
    );
    if (changed.length > 0) {
      throw new ForbiddenException(`Only an admin can change: ${changed.join(', ')}`);
    }
  }

  private cached<T>(request: object, key: string, load: () => Promise<T>): Promise<T> {
    let store = this.perRequest.get(request);
    if (!store) {
      store = new Map();
      this.perRequest.set(request, store);
    }
    const hit = store.get(key);
    if (hit) return hit as Promise<T>;
    const pending = load();
    store.set(key, pending);
    return pending;
  }
}
