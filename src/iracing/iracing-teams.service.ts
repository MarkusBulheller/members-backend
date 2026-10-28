import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateIracingTeamDto, UpdateIracingTeamDto } from './dto/update-iracing-team.dto.js';
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

  /** Active teams only unless `includeInactive` (the controller only passes that for admins). */
  list(includeInactive = false): Promise<IracingTeam[]> {
    return this.teamsRepository.find({
      where: includeInactive ? {} : { active: true },
      relations: TEAM_RELATIONS,
      order: { teamName: 'ASC' },
    });
  }

  /** Admin switches: `active` hides a team that isn't ours (and turns its auto-import off);
   * `autoImport` watches it for new race results (not allowed on an inactive team). */
  async update(teamId: number, dto: UpdateIracingTeamDto): Promise<IracingTeam> {
    const id = Math.abs(teamId);
    const team = await this.teamsRepository.findOne({ where: { teamId: id } });
    if (!team) {
      throw new NotFoundException('iRacing team not found');
    }

    if (dto.teamName !== undefined && !team.manual) {
      throw new BadRequestException('Only a team that was added by hand can be renamed — synced names come from iRacing.');
    }

    const nextActive = dto.active ?? team.active;
    if (dto.autoImport === true && !nextActive) {
      throw new BadRequestException('An inactive team cannot be watched for new results — activate it first.');
    }

    let nextAutoImport = team.autoImport;
    if (!nextActive) {
      nextAutoImport = false;
    } else if (dto.autoImport !== undefined) {
      nextAutoImport = dto.autoImport;
    }

    await this.teamsRepository.update(
      { teamId: id },
      { active: nextActive, autoImport: nextAutoImport, ...(dto.teamName !== undefined ? { teamName: dto.teamName } : {}) },
    );
    return this.teamsRepository.findOneOrFail({ where: { teamId: id }, relations: TEAM_RELATIONS });
  }

  /** Adds a team by hand: for a team we are not a member of (so a sync can never find it) or one
   * that no longer exists on iRacing. Nothing is checked against iRacing, so it has no roster and
   * no owner (both 0). Its results can still be imported by team id. */
  async createManual(dto: CreateIracingTeamDto): Promise<IracingTeam> {
    const teamId = Math.abs(dto.teamId);
    // The negative form race results use may already be stored from before the abs() normalisation.
    const existing = await this.teamsRepository.findOne({ where: [{ teamId }, { teamId: -teamId }] });
    if (existing) {
      throw new ConflictException(`Team ${teamId} is already in the list as "${existing.teamName}".`);
    }
    await this.teamsRepository.insert({
      teamId,
      teamName: dto.teamName,
      ownerCustId: 0,
      rosterCount: 0,
      manual: true,
    });
    return this.teamsRepository.findOneOrFail({ where: { teamId }, relations: TEAM_RELATIONS });
  }

  /** Removes a team that was added by hand. Synced teams are not deletable (a sync would bring
   * them back) — deactivate those instead. Event crews that point at the id keep it. */
  async removeManual(teamId: number): Promise<void> {
    const id = Math.abs(teamId);
    const team = await this.teamsRepository.findOne({ where: { teamId: id } });
    if (!team) {
      throw new NotFoundException('iRacing team not found');
    }
    if (!team.manual) {
      throw new BadRequestException('Only a team that was added by hand can be removed — deactivate synced teams instead.');
    }
    await this.membersRepository.delete({ teamId: id });
    await this.teamsRepository.delete({ teamId: id });
  }

  /** Imports every team the OAuth-authenticating admin belongs to (not just one) — see
   * IracingService.exchangeCodeForTeamRosters(). Purely a cache refresh: doesn't touch
   * DriverProfile or this app's own roster in any way. Each team's member list is fully
   * re-derived (delete-then-recreate) rather than diffed, since nothing else references a
   * specific IracingTeamMember row by id. */
  async sync(code: string, codeVerifier: string): Promise<{ teamsSynced: number }> {
    const results = await this.iracingService.exchangeCodeForTeamRosters(code, codeVerifier);

    for (const result of results) {
      // Store the positive id (iRacing's membership data can hand back the negative form that team
      // entries use in race results). Drop a legacy row stored under the negative form so the team
      // doesn't appear twice.
      const teamId = Math.abs(result.teamId);
      await this.membersRepository.delete({ teamId: -teamId });
      await this.teamsRepository.delete({ teamId: -teamId });
      // Only these columns are written on conflict: the admin-controlled `active` / `auto_import`
      // flags (and last_checked_at) are deliberately absent so a re-sync never resets them — and
      // never re-activates a team an admin deactivated.
      await this.teamsRepository.upsert(
        {
          teamId,
          teamName: result.teamName,
          ownerCustId: result.ownerCustId,
          rosterCount: result.roster.length,
          // A real sync of a team that was added by hand makes it a normal synced team.
          manual: false,
        },
        ['teamId'],
      );

      await this.membersRepository.delete({ teamId });
      if (result.roster.length > 0) {
        const rows = result.roster.map((member) =>
          this.membersRepository.create({ teamId, custId: member.custId, displayName: member.displayName }),
        );
        await this.membersRepository.save(rows);
      }
    }

    return { teamsSynced: results.length };
  }
}
