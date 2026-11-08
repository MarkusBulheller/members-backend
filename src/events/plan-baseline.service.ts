import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SetPlanBaselineDto } from './dto/set-plan-baseline.dto.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeam } from './event-team.entity.js';
import { FollowStreamService } from './follow/follow-stream.service.js';
import type { PlanBaseline } from './plan-baseline.js';
import { TeamPlanEventsService } from './team-plan-events.service.js';

/** The original plan a crew's race is measured against ("vs plan" on the plan page and the overlay). */
@Injectable()
export class PlanBaselineService {
  constructor(
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint)
    private readonly stintsRepository: Repository<EventTeamStint>,
    private readonly planEvents: TeamPlanEventsService,
    private readonly streams: FollowStreamService,
  ) {}

  /** null until one is saved. */
  async get(eventId: string, teamId: string): Promise<PlanBaseline | null> {
    // planBaseline is select:false, so ask for it.
    const team = await this.teamsRepository.findOne({
      where: { id: teamId, eventId },
      select: { id: true, planBaseline: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team.planBaseline ?? null;
  }

  /** Saves (or replaces) the baseline. Every stint in it must be one of the team's stints. */
  async set(eventId: string, teamId: string, dto: SetPlanBaselineDto, actorUserId?: string): Promise<PlanBaseline> {
    await this.get(eventId, teamId); // 404 for a team of another event
    const known = new Set((await this.stintsRepository.find({ where: { eventTeamId: teamId }, select: { id: true } })).map((s) => s.id));
    if (dto.stints.some((stint) => !known.has(stint.id))) {
      throw new BadRequestException('The plan contains a stint that does not belong to this team');
    }
    const baseline: PlanBaseline = {
      takenAt: new Date().toISOString(),
      source: dto.source ?? 'MANUAL',
      stints: dto.stints.map((stint) => ({ id: stint.id, startsAt: stint.startsAt, endsAt: stint.endsAt })),
    };
    await this.teamsRepository.update({ id: teamId, eventId }, { planBaseline: baseline });
    this.changed(eventId, teamId, actorUserId);
    return baseline;
  }

  async clear(eventId: string, teamId: string, actorUserId?: string): Promise<void> {
    await this.get(eventId, teamId);
    await this.teamsRepository.update({ id: teamId, eventId }, { planBaseline: null });
    this.changed(eventId, teamId, actorUserId);
  }

  /** Other plan pages reload it; open follow pages and overlays refetch (the drift depends on it). */
  private changed(eventId: string, teamId: string, actorUserId?: string): void {
    this.planEvents.emit(eventId, teamId, 'team', actorUserId);
    this.streams.notifyChanged(teamId);
  }
}
