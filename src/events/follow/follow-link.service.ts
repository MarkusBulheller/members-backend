import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { EventTeam } from '../event-team.entity.js';
import type { PublishPlanDto } from './dto/publish-plan.dto.js';
import type { UpdateFollowLinkDto } from './dto/update-follow-link.dto.js';
import { type FollowNamesMode, isFollowNamesMode } from './follow-names.js';
import { FollowStreamService } from './follow-stream.service.js';
import type { PublishedPlan } from './published-plan.js';

export interface FollowLink {
  enabled: boolean;
  token: string | null;
  namesMode: FollowNamesMode;
  /** The private strategy link: the same pages and overlay, with fuel and tyres on top. */
  strategy: { enabled: boolean; token: string | null };
}

/** 32 random bytes as base64url (43 chars). Never logged. */
export function generateFollowToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Admin side of a team's live links: the public "Follow the race" link and the private strategy
 * link (one of each per event team). */
@Injectable()
export class FollowLinkService {
  constructor(
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    private readonly streams: FollowStreamService,
  ) {}

  async get(eventId: string, teamId: string): Promise<FollowLink> {
    return toLink(await this.load(eventId, teamId));
  }

  async update(eventId: string, teamId: string, dto: UpdateFollowLinkDto): Promise<FollowLink> {
    const team = await this.load(eventId, teamId);
    const previousToken = team.followToken ?? null;
    const previousStrategyToken = team.strategyToken ?? null;

    const token = nextToken(previousToken, dto.enabled, dto.regenerate);
    const strategyToken = nextToken(previousStrategyToken, dto.strategyEnabled, dto.regenerateStrategy);
    const namesMode = dto.namesMode ?? (isFollowNamesMode(team.followNames) ? team.followNames : 'FULL');

    const tokenChanged = token !== previousToken;
    const strategyChanged = strategyToken !== previousStrategyToken;
    const namesChanged = namesMode !== team.followNames;
    if (tokenChanged || strategyChanged || namesChanged) {
      await this.teamsRepository.update(
        { id: teamId, eventId },
        {
          ...(tokenChanged || namesChanged ? { followToken: token, followNames: namesMode } : {}),
          ...(strategyChanged ? { strategyToken } : {}),
        },
      );
    }

    // Open pages hear about it right away. Deliberately NOT emitted on the planner's stream.
    if (previousToken !== null && tokenChanged) this.streams.notifyRevoked(teamId, previousToken);
    if (previousStrategyToken !== null && strategyChanged) this.streams.notifyRevoked(teamId, previousStrategyToken);
    if (namesChanged && ((token !== null && !tokenChanged) || (strategyToken !== null && !strategyChanged))) {
      this.streams.notifyChanged(teamId);
    }

    return {
      enabled: token !== null,
      token,
      namesMode,
      strategy: { enabled: strategyToken !== null, token: strategyToken },
    };
  }

  /** Stores the schedule the plan page computed (times, fuel, tyres) so the follow page and the
   * overlay show what the planner shows. Open pages are nudged to refetch. */
  async publishPlan(eventId: string, teamId: string, dto: PublishPlanDto): Promise<void> {
    await this.load(eventId, teamId);
    const plan: PublishedPlan = {
      publishedAt: new Date().toISOString(),
      stints: dto.stints.map((stint) => ({
        id: stint.id,
        startsAt: stint.startsAt,
        endsAt: stint.endsAt,
        fuelLiters: stint.fuelLiters ?? null,
        tyres: stint.tyres ?? null,
      })),
    };
    await this.teamsRepository.update({ id: teamId, eventId }, { publishedPlan: plan });
    this.streams.notifyChanged(teamId);
  }

  private async load(eventId: string, teamId: string): Promise<EventTeam> {
    // followToken / strategyToken are select:false (they must not leak through ordinary team
    // reads), so ask for them.
    const team = await this.teamsRepository.findOne({
      where: { id: teamId, eventId },
      select: { id: true, eventId: true, followToken: true, strategyToken: true, followNames: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }
}

/** enabled false = revoke; regenerate (or enabled on a link without a token) = a new token. */
function nextToken(current: string | null, enabled: boolean | undefined, regenerate: boolean | undefined): string | null {
  if (enabled === false) return null;
  if (regenerate === true || (enabled === true && current === null)) return generateFollowToken();
  return current;
}

function toLink(team: EventTeam): FollowLink {
  const token = team.followToken ?? null;
  const strategyToken = team.strategyToken ?? null;
  return {
    enabled: token !== null,
    token,
    namesMode: isFollowNamesMode(team.followNames) ? team.followNames : 'FULL',
    strategy: { enabled: strategyToken !== null, token: strategyToken },
  };
}
