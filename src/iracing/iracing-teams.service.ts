import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IracingTeamMember } from './iracing-team-member.entity.js';
import { IracingTeam } from './iracing-team.entity.js';
import { IracingService } from './iracing.service.js';

const TEAM_RELATIONS = { members: true } as const;

@Injectable()
export class IracingTeamsService {
  constructor(
    @InjectRepository(IracingTeam)
    private readonly teamsRepository: Repository<IracingTeam>,
    @InjectRepository(IracingTeamMember)
    private readonly membersRepository: Repository<IracingTeamMember>,
    private readonly iracingService: IracingService,
  ) {}

  list(): Promise<IracingTeam[]> {
    return this.teamsRepository.find({ relations: TEAM_RELATIONS, order: { teamName: 'ASC' } });
  }

  /** Imports every team the OAuth-authenticating admin belongs to (not just one) — see
   * IracingService.exchangeCodeForTeamRosters(). Purely a cache refresh: doesn't touch
   * DriverProfile or this app's own roster in any way. Each team's member list is fully
   * re-derived (delete-then-recreate) rather than diffed, since nothing else references a
   * specific IracingTeamMember row by id. */
  async sync(code: string, codeVerifier: string): Promise<{ teamsSynced: number }> {
    const results = await this.iracingService.exchangeCodeForTeamRosters(code, codeVerifier);

    for (const result of results) {
      await this.teamsRepository.upsert(
        {
          teamId: result.teamId,
          teamName: result.teamName,
          ownerCustId: result.ownerCustId,
          rosterCount: result.roster.length,
        },
        ['teamId'],
      );

      await this.membersRepository.delete({ teamId: result.teamId });
      if (result.roster.length > 0) {
        const rows = result.roster.map((member) =>
          this.membersRepository.create({ teamId: result.teamId, custId: member.custId, displayName: member.displayName }),
        );
        await this.membersRepository.save(rows);
      }
    }

    return { teamsSynced: results.length };
  }
}
