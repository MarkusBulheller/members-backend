import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { EventTeam } from '../event-team.entity.js';
import type { UpdateFollowLinkDto } from './dto/update-follow-link.dto.js';
import { type FollowNamesMode, isFollowNamesMode } from './follow-names.js';
import { FollowStreamService } from './follow-stream.service.js';

export interface FollowLink {
  enabled: boolean;
  token: string | null;
  namesMode: FollowNamesMode;
}

/** 32 random bytes as base64url (43 chars). Never logged. */
export function generateFollowToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Admin side of the public "Follow the race" link (one private link per event team). */
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
    const hadToken = (team.followToken ?? null) !== null;

    const previousToken = team.followToken ?? null;
    let token = previousToken;
    if (dto.enabled === false) {
      token = null; // revoke
    } else if (dto.regenerate === true || (dto.enabled === true && token === null)) {
      token = generateFollowToken(); // new link; any previous one stops working
    }
    const namesMode = dto.namesMode ?? (isFollowNamesMode(team.followNames) ? team.followNames : 'FULL');

    const tokenChanged = token !== previousToken;
    const namesChanged = namesMode !== team.followNames;
    if (tokenChanged || namesChanged) {
      await this.teamsRepository.update({ id: teamId, eventId }, { followToken: token, followNames: namesMode });
    }

    // Open pages hear about it right away. Deliberately NOT emitted on the planner's stream.
    if (hadToken && tokenChanged) this.streams.notifyRevoked(teamId);
    else if (token !== null && namesChanged) this.streams.notifyChanged(teamId);

    return { enabled: token !== null, token, namesMode };
  }

  private async load(eventId: string, teamId: string): Promise<EventTeam> {
    // followToken is select:false (it must not leak through ordinary team reads), so ask for it.
    const team = await this.teamsRepository.findOne({
      where: { id: teamId, eventId },
      select: { id: true, eventId: true, followToken: true, followNames: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }
}

function toLink(team: EventTeam): FollowLink {
  return {
    enabled: team.followToken !== null && team.followToken !== undefined,
    token: team.followToken ?? null,
    namesMode: isFollowNamesMode(team.followNames) ? team.followNames : 'FULL',
  };
}
