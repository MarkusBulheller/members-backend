import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { EventTeam } from '../events/event-team.entity.js';
import { Event } from '../events/event.entity.js';
import { EventsService } from '../events/events.service.js';
import { RaceResult } from './race-result.entity.js';

/** How far the iRacing session's start may be from the event team's planned green flag. iRacing's
 * session start (start_time) is when the session opens, i.e. BEFORE the race: practice and
 * qualifying precede the green flag, so a result's start_time typically sits some minutes to an hour
 * before timeslot + race-start offset. 6 hours either side comfortably covers that while still
 * keeping a team's Saturday race apart from its Sunday one. */
export const EVENT_LINK_WINDOW_MS = 6 * 60 * 60 * 1000;

const NOT_LINKABLE_STATUSES: EventStatus[] = [EventStatus.DRAFT, EventStatus.CANCELLED];
const COMPLETABLE_STATUSES: EventStatus[] = [EventStatus.PUBLISHED, EventStatus.SIGNUPS_CLOSED];

/** After ANY successful race-result import (manual or automatic): matches the result to the event
 * team that raced it, and marks the event COMPLETED once every one of its timeslotted teams has a
 * result. Best-effort — a failure here is logged and never fails the import. Idempotent. */
@Injectable()
export class ResultEventLinkService {
  private readonly logger = new Logger(ResultEventLinkService.name);

  constructor(
    @InjectRepository(EventTeam)
    private readonly eventTeamsRepository: Repository<EventTeam>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
    private readonly eventsService: EventsService,
  ) {}

  async linkAndComplete(result: RaceResult): Promise<void> {
    try {
      if (!result.eventTeamId) {
        const match = await this.findMatchingEventTeam(result);
        if (!match) return;
        await this.raceResultsRepository.update(result.id, { eventId: match.eventId, eventTeamId: match.id });
        result.eventId = match.eventId;
        result.eventTeamId = match.id;
      }
      if (result.eventId) {
        await this.completeEventIfAllTeamsHaveResults(result.eventId);
      }
    } catch (error) {
      this.logger.error(
        `Linking race result ${result.id} to an event failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The event team (of a non-DRAFT/CANCELLED event, with a timeslot) for the result's iRacing team
   * whose planned race start is within ±6h of the result's session start; the closest wins. */
  private async findMatchingEventTeam(result: RaceResult): Promise<EventTeam | null> {
    if (!result.startTime) return null;
    const startMs = result.startTime.getTime();

    // event_teams.iracing_team_id may hold iRacing's negative form of the id.
    const candidates = await this.eventTeamsRepository.find({
      where: { iracingTeamId: In([result.teamId, -result.teamId]) },
      relations: { event: true, timeslot: true },
    });

    let best: EventTeam | null = null;
    let bestDistance = Infinity;
    for (const team of candidates) {
      if (!team.event || NOT_LINKABLE_STATUSES.includes(team.event.status) || !team.timeslot) continue;
      const offsetMinutes = Number(team.raceStartOffsetMinutes ?? 0);
      const raceStartMs = team.timeslot.startsAt.getTime() + (Number.isFinite(offsetMinutes) ? offsetMinutes : 0) * 60_000;
      const distance = Math.abs(raceStartMs - startMs);
      if (distance <= EVENT_LINK_WINDOW_MS && distance < bestDistance) {
        best = team;
        bestDistance = distance;
      }
    }
    return best;
  }

  private async completeEventIfAllTeamsHaveResults(eventId: string): Promise<void> {
    const event = await this.eventsRepository.findOne({ where: { id: eventId } });
    if (!event || !COMPLETABLE_STATUSES.includes(event.status)) return;

    const teams = await this.eventTeamsRepository.find({ where: { eventId, timeslotId: Not(IsNull()) } });
    if (teams.length === 0) return;

    const linked = await this.raceResultsRepository.find({
      where: { eventId, eventTeamId: In(teams.map((team) => team.id)) },
      select: { id: true, eventTeamId: true },
    });
    const teamsWithResult = new Set(linked.map((row) => row.eventTeamId));
    if (!teams.every((team) => teamsWithResult.has(team.id))) return;

    // Through EventsService.update so the live planner gets its 'event' signal and the Discord
    // announcement is refreshed, exactly like an admin changing the status by hand.
    await this.eventsService.update(eventId, { status: EventStatus.COMPLETED });
    this.logger.log(`Event ${eventId} marked COMPLETED: every team with a timeslot has a result.`);
  }
}
