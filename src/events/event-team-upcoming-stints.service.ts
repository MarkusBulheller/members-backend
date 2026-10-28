import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { Sim } from '../common/enums/sim.enum.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeam } from './event-team.entity.js';
import { Event } from './event.entity.js';
import { EventsService, type UpcomingStintAssignment } from './events.service.js';
import { tyreStopSeconds } from './tyre-change.util.js';

/** One stint of a crew's saved rotation, as the dashboard shows it. */
export interface UpcomingStintSlot {
  startsAt: string;
  endsAt: string;
  /** True when the requesting driver is the one driving this stint. */
  isMine: boolean;
  /** Display name of whoever drives it; null for an unassigned stint or an unknown driver id. */
  driverName: string | null;
}

/** GET /events/mine/upcoming-stints payload: the event/team-level assignment (see
 * EventsService.findUpcomingStintAssignmentsForUser) plus the track and the crew's whole rotation. */
export interface UpcomingStintAssignmentDetail extends UpcomingStintAssignment {
  trackName: string | null;
  /** The crew's saved stint rotation in order; empty when no stint plan is saved or the crew has
   * no committed start time to schedule from. */
  stints: UpcomingStintSlot[];
}

function parseDecimal(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Walks a crew's stints with the same theoretical cascade the planning page and
 * EventsService use (stored durations, pit time from the team's settings, "splash and go" stints
 * skip the tyre change, a recorded actualStartAt re-anchors everything after it) and returns each
 * stint's start/end. `stints` must already be in `order`. */
export function buildStintSlots(
  team: Pick<EventTeam, 'refuelDurationSeconds' | 'tyreChangeDurationSeconds' | 'pitstopDrivethroughSeconds'> &
    Partial<Pick<EventTeam, 'partialTyreChangeSeconds'>>,
  stints: (Pick<EventTeamStint, 'driverUserId' | 'durationMinutes' | 'tyreChange' | 'actualStartAt'> &
    Partial<Pick<EventTeamStint, 'tyresChanged'>>)[],
  timeslotStartsAtMs: number,
  userId: string,
  nameFor: (driverId: string) => string | null,
  /** LMU events price the tyre portion of a stop per tyre (see tyreStopSeconds); anything else
   * keeps the boolean tyreChange rule. */
  sim?: Sim,
): UpcomingStintSlot[] {
  const refuelMinutes = (parseDecimal(team.refuelDurationSeconds) ?? 0) / 60;
  const driveMinutes = (parseDecimal(team.pitstopDrivethroughSeconds) ?? 0) / 60;

  const slots: UpcomingStintSlot[] = [];
  let cursorMs = timeslotStartsAtMs;
  for (const [index, stint] of stints.entries()) {
    const pitBeforeMinutes =
      index === 0 ? 0 : refuelMinutes + driveMinutes + tyreStopSeconds(stint, team, sim) / 60;
    const startMs = stint.actualStartAt ? stint.actualStartAt.getTime() : cursorMs + pitBeforeMinutes * 60_000;
    const endMs = startMs + (parseDecimal(stint.durationMinutes) ?? 0) * 60_000;
    slots.push({
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      isMine: stint.driverUserId !== null && stint.driverUserId === userId,
      driverName: stint.driverUserId !== null ? nameFor(stint.driverUserId) : null,
    });
    cursorMs = endMs;
  }
  return slots;
}

/** Decorates the dashboard's upcoming-stint assignments with the track name and the crew's saved
 * stint rotation. Lives beside (not inside) EventsService so that service's constructor and
 * existing behaviour stay untouched. */
@Injectable()
export class EventTeamUpcomingStintsService {
  constructor(
    private readonly eventsService: EventsService,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint)
    private readonly stintsRepository: Repository<EventTeamStint>,
    @InjectRepository(EventTeamDummyDriver)
    private readonly dummiesRepository: Repository<EventTeamDummyDriver>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
  ) {}

  async findForUser(userId: string): Promise<UpcomingStintAssignmentDetail[]> {
    const assignments = await this.eventsService.findUpcomingStintAssignmentsForUser(userId);
    if (assignments.length === 0) return [];

    const teamIds = assignments.map((a) => a.teamId);
    const eventIds = [...new Set(assignments.map((a) => a.eventId))];

    const [events, teams, stints, dummies] = await Promise.all([
      this.eventsRepository.find({ where: { id: In(eventIds) }, relations: { track: true } }),
      this.teamsRepository.find({ where: { id: In(teamIds) } }),
      this.stintsRepository.find({ where: { eventTeamId: In(teamIds) }, order: { order: 'ASC' } }),
      this.dummiesRepository.find({ where: { eventTeamId: In(teamIds) } }),
    ]);

    const driverUserIds = [...new Set(stints.flatMap((s) => (s.driverUserId ? [s.driverUserId] : [])))];
    const profiles =
      driverUserIds.length > 0
        ? await this.driverProfilesRepository.find({ where: { userId: In(driverUserIds) } })
        : [];

    const names = new Map<string, string>();
    for (const p of profiles) {
      if (p.userId) names.set(p.userId, p.iracingName ?? p.displayName);
    }
    for (const d of dummies) names.set(d.id, d.name);

    const trackNameByEvent = new Map(events.map((e) => [e.id, e.track?.name ?? null]));
    const simByEvent = new Map(events.map((e) => [e.id, e.sim]));
    const teamById = new Map(teams.map((t) => [t.id, t]));

    return assignments.map((assignment) => {
      const team = teamById.get(assignment.teamId);
      const teamStints = stints.filter((s) => s.eventTeamId === assignment.teamId);
      // Counted from the green flag (timeslot + race-start offset), like the plan page.
      const anchor = assignment.raceStartsAt ?? assignment.timeslotStartsAt;
      const startsAtMs = anchor ? Date.parse(anchor) : null;
      return {
        ...assignment,
        trackName: trackNameByEvent.get(assignment.eventId) ?? null,
        stints:
          team && startsAtMs !== null && teamStints.length > 0
            ? buildStintSlots(team, teamStints, startsAtMs, userId, (id) => names.get(id) ?? null, simByEvent.get(team.eventId))
            : [],
      };
    });
  }
}
