import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { EventSignup } from '../events/event-signup.entity.js';
import { EventTeamLead } from '../events/event-team-lead.entity.js';
import { EventTeam } from '../events/event-team.entity.js';
import { User } from '../users/user.entity.js';

export interface TeamLeadView {
  userId: string;
  name: string;
}

/** Most leads one event crew can have. */
export const MAX_TEAM_LEADS = 5;

function displayName(user: Pick<User, 'discordGlobalName' | 'discordUsername'> | null | undefined): string {
  return user?.discordGlobalName || user?.discordUsername || 'Unknown member';
}

/** Admin management of event-crew leads + the "which crews do I lead" lookup for /auth/me.
 * A lead belongs to exactly one EventTeam (one crew of one event) and must be a driver placed on it. */
@Injectable()
export class TeamLeadsService {
  constructor(
    @InjectRepository(EventTeamLead) private readonly leads: Repository<EventTeamLead>,
    @InjectRepository(EventTeam) private readonly eventTeams: Repository<EventTeam>,
    @InjectRepository(EventSignup) private readonly signups: Repository<EventSignup>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** Leads of one crew; 404 when the crew isn't part of `eventId`. */
  async listForEventTeam(eventId: string, eventTeamId: string): Promise<TeamLeadView[]> {
    const team = await this.eventTeams.findOne({ where: { id: eventTeamId, eventId } });
    if (!team) throw new NotFoundException('Team not found for this event');
    return this.loadLeads(eventTeamId);
  }

  private async loadLeads(eventTeamId: string): Promise<TeamLeadView[]> {
    const rows = await this.leads.find({
      where: { eventTeamId },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({ userId: row.userId, name: displayName(row.user) }));
  }

  /** Replaces the whole lead set of one crew. Every id must be an APPROVED member with an active
   * (non-cancelled) signup placed on this very crew, at most {@link MAX_TEAM_LEADS}; otherwise
   * the whole request is rejected with 400 and nothing is written. */
  async replaceForEventTeam(eventId: string, eventTeamId: string, userIds: string[]): Promise<TeamLeadView[]> {
    const team = await this.eventTeams.findOne({ where: { id: eventTeamId, eventId } });
    if (!team) throw new NotFoundException('Team not found for this event');

    const unique = [...new Set(userIds)];
    if (unique.length > MAX_TEAM_LEADS) {
      throw new BadRequestException(`A crew can have at most ${MAX_TEAM_LEADS} team leads`);
    }
    if (unique.length > 0) {
      const approved = await this.users.find({ where: { id: In(unique), status: UserStatus.APPROVED } });
      const placed = await this.signups.find({
        where: { eventTeamId, userId: In(unique), status: Not(SignupStatus.CANCELLED) },
      });
      const approvedIds = new Set(approved.map((user) => user.id));
      const placedIds = new Set(placed.map((signup) => signup.userId));
      if (unique.some((userId) => !approvedIds.has(userId))) {
        throw new BadRequestException('Only approved members can be team leads');
      }
      if (unique.some((userId) => !placedIds.has(userId))) {
        throw new BadRequestException('A team lead must be a driver placed on this crew');
      }
    }

    await this.leads.manager.transaction(async (manager) => {
      await manager.delete(EventTeamLead, { eventTeamId });
      if (unique.length > 0) {
        await manager.insert(
          EventTeamLead,
          unique.map((userId) => ({ eventTeamId, userId })),
        );
      }
    });
    return this.loadLeads(eventTeamId);
  }

  /** Event team ids this user currently leads (`[]` if none) - GET /auth/me's `leadOfEventTeamIds`.
   * Only crews the user is still placed on (non-cancelled signup) count, and only while APPROVED,
   * mirroring what TeamManagePolicy would allow. */
  async eventTeamIdsLedBy(userId: string): Promise<string[]> {
    const rows = await this.leads.find({ where: { userId }, order: { createdAt: 'ASC' } });
    if (rows.length === 0) return [];
    const approved = await this.users.exists({ where: { id: userId, status: UserStatus.APPROVED } });
    if (!approved) return [];
    const placed = await this.signups.find({
      where: { userId, eventTeamId: In(rows.map((row) => row.eventTeamId)), status: Not(SignupStatus.CANCELLED) },
      select: { id: true, eventTeamId: true },
    });
    const placedOn = new Set(placed.map((signup) => signup.eventTeamId));
    return rows.map((row) => row.eventTeamId).filter((id) => placedOn.has(id));
  }
}
