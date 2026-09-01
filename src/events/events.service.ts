import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { EventSignup } from './event-signup.entity.js';
import { EventTeam } from './event-team.entity.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { Event } from './event.entity.js';

const EVENT_RELATIONS = { track: true, timeslots: true } as const;

/** Only what the anonymous public marketing site's "Race Schedule" needs — no signups, no
 * driver-facing detail, just enough to list what's coming up. See PublicEventsController. */
export interface PublicUpcomingEvent {
  id: string;
  title: string;
  trackName: string;
  carClasses: string[];
  startsAt: string;
}

/** One team a driver has a stint assignment in, for an event that hasn't fully finished yet — see
 * EventsService.findUpcomingStintAssignmentsForUser(). Deliberately event/team-level, not a precise
 * stint-by-stint schedule: that requires the same live fuel-tank/pace cascade the planning page
 * runs (driver settings, weather, frozen history), which isn't worth replicating server-side just
 * to power a dashboard "you're racing" reminder. */
export interface UpcomingStintAssignment {
  eventId: string;
  eventTitle: string;
  teamId: string;
  teamName: string;
  timeslotStartsAt: string | null;
  raceLengthMinutes: number;
  isLive: boolean;
  /** This driver's next stint in the crew's rotation, if one is still ahead of them — null once
   * they have none left (or the team has no committed timeslot to schedule from at all). Uses
   * each stint's *stored* duration and real actualStartAt anchors, not the live fuel-tank/pace
   * recalculation the planning page does per driver — good enough for a countdown, not worth
   * replicating that whole cascade server-side just for this. */
  nextStintStartsAt: string | null;
}

function parseDecimal(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Same theoretical cascade the planning page runs, minus the live driver-pace/fuel-tank layer:
 * each stint's stored duration, pit time from the team's settings (skipped for a "splash and go"
 * stint whose tyreChange is false), and any real actualStartAt re-anchoring the rest from reality.
 * Returns the first of `userId`'s own stints whose computed start is still ahead of `now`. */
function computeNextStintStart(
  team: EventTeam,
  stints: EventTeamStint[],
  userId: string,
  timeslotStartsAtMs: number,
  now: number,
): Date | null {
  const refuelMinutes = (parseDecimal(team.refuelDurationSeconds) ?? 0) / 60;
  const tyreMinutes = (parseDecimal(team.tyreChangeDurationSeconds) ?? 0) / 60;
  const driveMinutes = (parseDecimal(team.pitstopDrivethroughSeconds) ?? 0) / 60;

  let cursorMs = timeslotStartsAtMs;
  for (const [index, stint] of stints.entries()) {
    const pitBeforeMinutes = index === 0 ? 0 : refuelMinutes + driveMinutes + (stint.tyreChange ? tyreMinutes : 0);
    const theoreticalStartMs = cursorMs + pitBeforeMinutes * 60_000;
    const actualStartMs = stint.actualStartAt ? stint.actualStartAt.getTime() : null;
    const startMs = actualStartMs ?? theoreticalStartMs;

    if (stint.driverUserId === userId && startMs >= now) {
      return new Date(startMs);
    }

    const durationMinutes = parseDecimal(stint.durationMinutes) ?? 0;
    cursorMs = startMs + durationMinutes * 60_000;
  }
  return null;
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventSignup)
    private readonly signupsRepository: Repository<EventSignup>,
    @InjectRepository(EventTimeslot)
    private readonly timeslotsRepository: Repository<EventTimeslot>,
    @InjectRepository(EventTeam)
    private readonly eventTeamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint)
    private readonly eventTeamStintsRepository: Repository<EventTeamStint>,
    private readonly discordBotService: DiscordBotService,
  ) {}

  /** Every team this driver has at least one stint in, for an event that's live or still to come
   * — used for the dashboard's "you're on the entry list" prominent callout. A driver's own
   * assignments are always a handful of rows at most, so this fetches and filters in JS rather
   * than replicating the filter as fragile raw-SQL interval arithmetic. */
  async findUpcomingStintAssignmentsForUser(userId: string): Promise<UpcomingStintAssignment[]> {
    const stints = await this.eventTeamStintsRepository.find({
      where: { driverUserId: userId },
      relations: { eventTeam: { event: true, timeslot: true } },
    });

    const now = Date.now();
    const seenTeamIds = new Set<string>();
    const assignments: UpcomingStintAssignment[] = [];

    // Teams and stint plans only exist from SIGNUPS_CLOSED onward (see EventStatus) — PUBLISHED
    // alone would miss the exact phase a driver's assignment first appears in. Only DRAFT (no
    // real teams yet) and CANCELLED/COMPLETED (nothing to show up for) are excluded.
    const relevantStatuses: EventStatus[] = [EventStatus.SIGNUPS_CLOSED, EventStatus.PUBLISHED];

    for (const stint of stints) {
      const team = stint.eventTeam;
      const event = team.event;
      if (!relevantStatuses.includes(event.status) || seenTeamIds.has(team.id)) {
        continue;
      }

      const timeslotStartsAt = team.timeslot?.startsAt ?? null;
      if (timeslotStartsAt) {
        const endMs = timeslotStartsAt.getTime() + event.raceLengthMinutes * 60_000;
        if (endMs < now) {
          continue; // this crew's race is already fully over
        }
      }

      seenTeamIds.add(team.id);

      let nextStintStartsAt: Date | null = null;
      if (timeslotStartsAt) {
        const teamStints = await this.eventTeamStintsRepository.find({
          where: { eventTeamId: team.id },
          order: { order: 'ASC' },
        });
        nextStintStartsAt = computeNextStintStart(team, teamStints, userId, timeslotStartsAt.getTime(), now);
      }

      assignments.push({
        eventId: event.id,
        eventTitle: event.title,
        teamId: team.id,
        teamName: team.name,
        timeslotStartsAt: timeslotStartsAt ? timeslotStartsAt.toISOString() : null,
        raceLengthMinutes: event.raceLengthMinutes,
        isLive: timeslotStartsAt
          ? now >= timeslotStartsAt.getTime() && now < timeslotStartsAt.getTime() + event.raceLengthMinutes * 60_000
          : false,
        nextStintStartsAt: nextStintStartsAt ? nextStintStartsAt.toISOString() : null,
      });
    }

    // Soonest first; assignments with no committed timeslot yet sort last.
    return assignments.sort((a, b) => {
      if (a.timeslotStartsAt === null) return b.timeslotStartsAt === null ? 0 : 1;
      if (b.timeslotStartsAt === null) return -1;
      return a.timeslotStartsAt.localeCompare(b.timeslotStartsAt);
    });
  }

  async create(dto: CreateEventDto, createdByUserId: string): Promise<Event> {
    const { timeslots, ...eventData } = dto;
    const event = this.eventsRepository.create({ ...eventData, createdByUserId });
    const saved = await this.eventsRepository.save(event);

    const timeslotRows = timeslots.map((startsAt) =>
      this.timeslotsRepository.create({ eventId: saved.id, startsAt: new Date(startsAt) }),
    );
    await this.timeslotsRepository.save(timeslotRows);

    const result = await this.findRawByIdOrThrow(saved.id);
    if (result.status === EventStatus.PUBLISHED) {
      void this.discordBotService.postEventAnnouncement(result);
    }
    return result;
  }

  async update(id: string, dto: UpdateEventDto): Promise<Event> {
    const event = await this.findRawByIdOrThrow(id);
    const wasPublished = event.status === EventStatus.PUBLISHED;
    const { timeslots, ...eventData } = dto;
    Object.assign(event, eventData);
    await this.eventsRepository.save(event);

    if (timeslots) {
      await this.syncTimeslots(event, timeslots);
    }

    const result = await this.findRawByIdOrThrow(id);
    // Only the DRAFT/CANCELLED → PUBLISHED transition announces — re-saving an already-published
    // event (e.g. tweaking its description) must not re-post.
    if (!wasPublished && result.status === EventStatus.PUBLISHED) {
      void this.discordBotService.postEventAnnouncement(result);
    }
    return result;
  }

  /** Keeps any existing timeslot whose start time is still present in the new list (so signups
   * already tied to it survive), deletes the ones dropped, and adds the ones newly added —
   * rather than a naive delete-all-and-recreate, which would silently orphan every driver's
   * existing availability picks. */
  private async syncTimeslots(event: Event, newStartTimes: string[]): Promise<void> {
    const newTimestamps = new Set(newStartTimes.map((s) => new Date(s).getTime()));
    const existing = event.timeslots ?? [];
    const existingTimestamps = new Set(existing.map((slot) => slot.startsAt.getTime()));

    const toRemove = existing.filter((slot) => !newTimestamps.has(slot.startsAt.getTime()));
    if (toRemove.length > 0) {
      await this.timeslotsRepository.remove(toRemove);
    }

    const toAdd = newStartTimes
      .filter((s) => !existingTimestamps.has(new Date(s).getTime()))
      .map((startsAt) => this.timeslotsRepository.create({ eventId: event.id, startsAt: new Date(startsAt) }));
    if (toAdd.length > 0) {
      await this.timeslotsRepository.save(toAdd);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.eventsRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Event not found');
    }
  }

  private findRawByIdOrThrow(id: string): Promise<Event> {
    return this.eventsRepository
      .findOneOrFail({ where: { id }, relations: EVENT_RELATIONS })
      .catch(() => {
        throw new NotFoundException('Event not found');
      });
  }

  /** Every status shows here, not just PUBLISHED — a DRAFT the admin hasn't announced yet, or one
   * mid-team-building in SIGNUPS_CLOSED, is still a real race the public schedule should reflect
   * as long as it hasn't actually finished. "Finished" is endsAt if the admin set one, otherwise
   * the implied end (startsAt + raceLengthMinutes) — a currently-running multi-hour race must
   * keep showing, so this can't just check startsAt like the old PUBLISHED-only version did. */
  async findPublicUpcoming(limit: number): Promise<PublicUpcomingEvent[]> {
    const events = await this.eventsRepository.find({
      relations: { track: true },
      order: { startsAt: 'ASC' },
    });
    const now = Date.now();
    return events
      .filter((event) => {
        const endMs = event.endsAt ? event.endsAt.getTime() : event.startsAt.getTime() + event.raceLengthMinutes * 60_000;
        return endMs >= now;
      })
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        title: event.title,
        trackName: event.track.name,
        carClasses: event.carClasses,
        startsAt: event.startsAt.toISOString(),
      }));
  }

  // Same DRAFT-only restriction as findByIdForViewer — a member's own events list must include
  // everything they might want to check on (SIGNUPS_CLOSED while stints are being planned,
  // COMPLETED for history), or the list and the detail page disagree about what's visible.
  findAllForViewer(isAdmin: boolean): Promise<Event[]> {
    return this.eventsRepository.find({
      where: isAdmin ? {} : { status: Not(EventStatus.DRAFT) },
      relations: EVENT_RELATIONS,
      order: { startsAt: 'ASC' },
    });
  }

  async findByIdForViewer(id: string, isAdmin: boolean): Promise<Event & { signups: EventSignup[] }> {
    const event = await this.findRawByIdOrThrow(id);

    // DRAFT is the only status actually hidden from members — an admin's still-being-set-up
    // event, not real/announced yet. Every later status (PUBLISHED, SIGNUPS_CLOSED while teams
    // are being built and stints planned, CANCELLED, COMPLETED) is real and a member may need to
    // see it — signups close well before a race, and stint planning happens entirely within
    // SIGNUPS_CLOSED, so restricting to PUBLISHED-only here made the stint plan page (and this
    // event) invisible to members for the exact window they'd actually want to check it.
    if (!isAdmin && event.status === EventStatus.DRAFT) {
      throw new NotFoundException('Event not found');
    }

    const signups = await this.signupsRepository.find({
      where: { eventId: id },
      relations: { timeslots: true },
      order: { signedUpAt: 'ASC' },
    });

    return { ...event, signups };
  }

  /** Always confirms — there's no capacity to overflow, `timeslotIds` is just an availability
   * signal (which of the event's candidate start times this driver can do), not a limited
   * resource. Reactivates a previously-cancelled signup instead of erroring, so a member who
   * changes their mind (or just updates which slots they can do) can simply sign up again.
   *
   * Fields are updated independently: a field left `undefined` in the dto is untouched (so the
   * UI can save e.g. just a timeslot toggle without clobbering the driver's already-chosen car
   * class), `null` clears it, and a value sets it. */
  async signup(eventId: string, userId: string, dto: SignupDto): Promise<EventSignup> {
    const event = await this.findRawByIdOrThrow(eventId);
    if (event.status !== EventStatus.PUBLISHED) {
      throw new ForbiddenException('This event is not open for signups');
    }

    if (dto.carClass && !event.carClasses.includes(dto.carClass)) {
      throw new ForbiddenException('That car class is not offered for this event');
    }
    if (dto.secondaryCarClass && !event.carClasses.includes(dto.secondaryCarClass)) {
      throw new ForbiddenException('That secondary car class is not offered for this event');
    }
    if (dto.availableHours && !this.hoursFitEventTimeslots(dto.availableHours, event)) {
      throw new ForbiddenException("Availability hour doesn't fall within any of this event's timeslots");
    }

    let timeslots: EventTimeslot[] | undefined;
    if (dto.timeslotIds !== undefined) {
      timeslots = dto.timeslotIds.length
        ? await this.timeslotsRepository.find({ where: { id: In(dto.timeslotIds), eventId } })
        : [];
    }

    const existing = await this.signupsRepository.findOne({
      where: { eventId, userId },
      relations: { timeslots: true },
    });

    if (existing) {
      existing.status = SignupStatus.CONFIRMED;
      if (dto.carId !== undefined) existing.carId = dto.carId;
      if (dto.carClass !== undefined) existing.carClass = dto.carClass;
      if (dto.secondaryCarClass !== undefined) existing.secondaryCarClass = dto.secondaryCarClass;
      if (dto.notes !== undefined) existing.notes = dto.notes;
      if (dto.availableHours !== undefined) existing.availableHours = dto.availableHours.map((h) => new Date(h));
      if (timeslots !== undefined) existing.timeslots = timeslots;
      return this.signupsRepository.save(existing);
    }

    const signup = this.signupsRepository.create({
      eventId,
      userId,
      carId: dto.carId ?? null,
      carClass: dto.carClass ?? null,
      secondaryCarClass: dto.secondaryCarClass ?? null,
      notes: dto.notes ?? null,
      availableHours: dto.availableHours?.map((h) => new Date(h)) ?? [],
      status: SignupStatus.CONFIRMED,
      timeslots: timeslots ?? [],
    });
    return this.signupsRepository.save(signup);
  }

  /** Every hour must land inside at least one of the event's timeslot windows — since a driver
   * picks their stint hours per timeslot on the frontend, this just guards against stale/forged
   * values rather than being a UX constraint. */
  private hoursFitEventTimeslots(hours: string[], event: Event): boolean {
    const raceMs = event.raceLengthMinutes * 60_000;
    return hours.every((iso) => {
      const t = new Date(iso).getTime();
      return event.timeslots.some((slot) => t >= slot.startsAt.getTime() && t < slot.startsAt.getTime() + raceMs);
    });
  }

  /** Places (or unplaces, if `eventTeamId` is null) a driver's signup onto one of the event's
   * teams — see EventTeam. Cross-checks the team belongs to the same event so a stray/forged id
   * can't attach a driver's roster entry to another event's crew. */
  async assignSignupTeam(eventId: string, signupId: string, eventTeamId: string | null): Promise<EventSignup> {
    const signup = await this.signupsRepository.findOne({ where: { id: signupId, eventId } });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }
    if (eventTeamId !== null) {
      const team = await this.eventTeamsRepository.findOne({ where: { id: eventTeamId, eventId } });
      if (!team) {
        throw new NotFoundException('Team not found for this event');
      }
    }
    signup.eventTeamId = eventTeamId;
    return this.signupsRepository.save(signup);
  }

  async cancelSignup(eventId: string, userId: string): Promise<void> {
    const signup = await this.signupsRepository.findOne({ where: { eventId, userId } });
    if (!signup || signup.status === SignupStatus.CANCELLED) {
      throw new NotFoundException('No active signup found');
    }

    signup.status = SignupStatus.CANCELLED;
    await this.signupsRepository.save(signup);
  }

  async adminOverrideSignup(signupId: string, status: SignupStatus): Promise<EventSignup> {
    const signup = await this.signupsRepository.findOne({ where: { id: signupId } });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }

    signup.status = status;
    return this.signupsRepository.save(signup);
  }

  /** Hard delete, unlike cancelSignup/adminOverrideSignup which only flip status — for admins
   * clearing out a signup entirely rather than recording it as cancelled. */
  async deleteSignup(eventId: string, signupId: string): Promise<void> {
    const result = await this.signupsRepository.delete({ id: signupId, eventId });
    if (result.affected === 0) {
      throw new NotFoundException('Signup not found');
    }
  }
}
