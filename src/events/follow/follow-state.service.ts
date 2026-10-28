import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Car } from '../../cars/car.entity.js';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import type { Sim } from '../../common/enums/sim.enum.js';
import { DriverProfile } from '../../drivers/driver-profile.entity.js';
import { EventTeamDummyDriver } from '../event-team-dummy-driver.entity.js';
import { EventTeamStint } from '../event-team-stint.entity.js';
import { EventTeam } from '../event-team.entity.js';
import { buildStintSlots } from '../event-team-upcoming-stints.service.js';
import { Event } from '../event.entity.js';
import { formatFollowName } from './follow-names.js';

/** The ONLY data the public follow page / OBS overlay ever receives. Anything added here is
 * published to anonymous visitors — keep it to who drives when plus the race clock. */
export interface FollowState {
  /** ISO, so clients can correct for a wrong local clock. */
  serverNow: string;
  event: { title: string; trackName: string; sim: 'IRACING' | 'LMU'; startsAt: string };
  team: { name: string; carName: string | null };
  /** startsAt = timeslot start + raceStartOffsetMinutes (null when the team has no timeslot);
   * endsAt = startsAt + lengthMinutes. */
  race: { startsAt: string | null; endsAt: string | null; lengthMinutes: number };
  stints: { number: number; driverName: string | null; startsAt: string | null; endsAt: string | null; started: boolean }[];
  stintCount: number;
}

/** Where a follow token points; what the SSE controller needs. */
export interface FollowTarget {
  teamId: string;
  eventId: string;
}

/** Shape of a token we could ever have minted (32 random bytes, base64url = 43 chars). Anything
 * else is rejected without touching the database. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

/** Same body for an unknown, revoked or hidden-event link, so nothing can be learned from it. */
function notFound(): NotFoundException {
  return new NotFoundException('Not found');
}

function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class FollowStateService {
  constructor(
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
    @InjectRepository(Car)
    private readonly carsRepository: Repository<Car>,
  ) {}

  /** Resolves a token to its team, or throws the uniform 404 (unknown / revoked / draft or
   * cancelled event). */
  async resolveTarget(token: string): Promise<FollowTarget> {
    const { team } = await this.load(token);
    return { teamId: team.id, eventId: team.eventId };
  }

  async getState(token: string): Promise<FollowState> {
    const { team, event } = await this.load(token);

    const [stints, dummies, car] = await Promise.all([
      this.stintsRepository.find({ where: { eventTeamId: team.id }, order: { order: 'ASC' } }),
      this.dummiesRepository.find({ where: { eventTeamId: team.id } }),
      team.carId ? this.carsRepository.findOne({ where: { id: team.carId }, select: { id: true, name: true } }) : null,
    ]);
    const driverUserIds = [...new Set(stints.flatMap((s) => (s.driverUserId ? [s.driverUserId] : [])))];
    const profiles =
      driverUserIds.length > 0 ? await this.driverProfilesRepository.find({ where: { userId: In(driverUserIds) } }) : [];

    // Same name resolution as the planner / dashboard: members by iRacing name (else display
    // name), roster guests and placeholders by their own name. Stints reference either a user id
    // or a dummy-driver id.
    const names = new Map<string, string>();
    for (const p of profiles) {
      if (p.userId) names.set(p.userId, p.iracingName ?? p.displayName);
    }
    for (const d of dummies) names.set(d.id, d.name);

    const offsetMinutes = parseDecimal(team.raceStartOffsetMinutes) ?? 0;
    const raceStartMs = team.timeslot ? team.timeslot.startsAt.getTime() + offsetMinutes * 60_000 : null;
    const lengthMinutes = event.raceLengthMinutes;

    // The cascade starts at the green flag (timeslot + offset), exactly like the readiness rules
    // and the planner, so the first stint begins when the race does.
    const slots =
      raceStartMs !== null
        ? buildStintSlots(team, stints, raceStartMs, '', (id) => formatFollowName(names.get(id), team.followNames), event.sim as Sim)
        : null;

    return {
      serverNow: new Date().toISOString(),
      event: {
        title: event.title,
        trackName: event.track?.name ?? '',
        sim: event.sim,
        startsAt: event.startsAt.toISOString(),
      },
      team: { name: team.name, carName: car?.name ?? null },
      race: {
        startsAt: raceStartMs !== null ? new Date(raceStartMs).toISOString() : null,
        endsAt: raceStartMs !== null ? new Date(raceStartMs + lengthMinutes * 60_000).toISOString() : null,
        lengthMinutes,
      },
      stints: stints.map((stint, index) => ({
        number: index + 1,
        driverName: slots
          ? slots[index].driverName
          : stint.driverUserId
            ? formatFollowName(names.get(stint.driverUserId), team.followNames)
            : null,
        startsAt: slots ? slots[index].startsAt : null,
        endsAt: slots ? slots[index].endsAt : null,
        started: stint.actualStartAt !== null,
      })),
      stintCount: stints.length,
    };
  }

  private async load(token: string): Promise<{ team: EventTeam; event: Event }> {
    if (!TOKEN_PATTERN.test(token)) throw notFound();
    const team = await this.teamsRepository.findOne({ where: { followToken: token }, relations: { timeslot: true } });
    if (!team) throw notFound();
    const event = await this.eventsRepository.findOne({ where: { id: team.eventId }, relations: { track: true } });
    if (!event || event.status === EventStatus.DRAFT || event.status === EventStatus.CANCELLED) throw notFound();
    return { team, event };
  }
}
