import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { toDecimalString } from '../common/decimal.util.js';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import type { Sim } from '../common/enums/sim.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { type AnnouncementSignup, DiscordBotService } from '../discord-bot/discord-bot.service.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { User } from '../users/user.entity.js';
import { AdminAddSignupDto } from './dto/admin-add-signup.dto.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { normalizeTimeslotPreference } from './timeslot-preference.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { EventSignup } from './event-signup.entity.js';
import {
  computeViewerStatus,
  type EventViewerStatus,
  type ViewerSignupLike,
  withViewerStatus,
} from './event-viewer-status.js';
import { EventTeamLead } from './event-team-lead.entity.js';
import { EventTeam } from './event-team.entity.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { Event } from './event.entity.js';
import { ALL_TEAMS, TeamPlanEventsService } from './team-plan-events.service.js';
import { tyreStopSeconds } from './tyre-change.util.js';

const EVENT_RELATIONS = { track: true, timeslots: true } as const;

/** Signups often arrive in bursts (an admin toggling hours, several people signing up at once) —
 * wait for things to settle before editing the Discord post, rather than editing it per change. */
const ANNOUNCEMENT_REFRESH_DEBOUNCE_MS = 3000;

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
  /** The green flag: the timeslot start plus the team's race-start offset (practice/qualifying
   * block). Stint times are counted from here — the plan page does the same. Null without a
   * timeslot. */
  raceStartsAt: string | null;
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
  sim?: Sim,
): Date | null {
  const refuelMinutes = (parseDecimal(team.refuelDurationSeconds) ?? 0) / 60;
  const driveMinutes = (parseDecimal(team.pitstopDrivethroughSeconds) ?? 0) / 60;

  let cursorMs = timeslotStartsAtMs;
  for (const [index, stint] of stints.entries()) {
    const pitBeforeMinutes =
      index === 0 ? 0 : refuelMinutes + driveMinutes + tyreStopSeconds(stint, team, sim) / 60;
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
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly announcementTimers = new Map<string, NodeJS.Timeout>();

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
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    private readonly discordBotService: DiscordBotService,
    @Optional() private readonly planEvents?: TeamPlanEventsService,
    // Lazy lookup of the guest-signups service (it depends on this service, so it can't be injected).
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @InjectRepository(EventTeamLead)
    private readonly teamLeadsRepository?: Repository<EventTeamLead>,
  ) {}

  /** A driver who leaves a crew (moved off it, cancelled, deleted) stops being its lead. Best
   * effort: TeamManagePolicy independently denies a lead who is no longer placed on the crew, so a
   * failure here never grants access, it only leaves a stale row that the policy ignores. */
  private async dropLead(eventTeamId: string | null, userId: string): Promise<void> {
    if (!eventTeamId || !this.teamLeadsRepository) return;
    try {
      await this.teamLeadsRepository.delete({ eventTeamId, userId });
    } catch (err) {
      this.logger.warn(
        `Removing team lead ${userId} of crew ${eventTeamId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
      // Stints (and the end of the race) are counted from the green flag, not from the timeslot's
      // own start: the team's race-start offset covers practice + qualifying ahead of the race.
      const raceStartMs = timeslotStartsAt
        ? timeslotStartsAt.getTime() + (parseDecimal(team.raceStartOffsetMinutes) ?? 0) * 60_000
        : null;
      if (raceStartMs !== null) {
        const endMs = raceStartMs + event.raceLengthMinutes * 60_000;
        if (endMs < now) {
          continue; // this crew's race is already fully over
        }
      }

      seenTeamIds.add(team.id);

      let nextStintStartsAt: Date | null = null;
      if (raceStartMs !== null) {
        const teamStints = await this.eventTeamStintsRepository.find({
          where: { eventTeamId: team.id },
          order: { order: 'ASC' },
        });
        nextStintStartsAt = computeNextStintStart(team, teamStints, userId, raceStartMs, now, event.sim);
      }

      assignments.push({
        eventId: event.id,
        eventTitle: event.title,
        teamId: team.id,
        teamName: team.name,
        timeslotStartsAt: timeslotStartsAt ? timeslotStartsAt.toISOString() : null,
        raceStartsAt: raceStartMs !== null ? new Date(raceStartMs).toISOString() : null,
        raceLengthMinutes: event.raceLengthMinutes,
        isLive: raceStartMs !== null ? now >= raceStartMs && now < raceStartMs + event.raceLengthMinutes * 60_000 : false,
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
    const { timeslots, fuelLimitPercent, tyreLimit, ...eventData } = dto;
    const event = this.eventsRepository.create({
      ...eventData,
      fuelLimitPercent: toDecimalString(fuelLimitPercent) ?? null,
      tyreLimit: tyreLimit ?? null,
      createdByUserId,
    });
    const saved = await this.eventsRepository.save(event);

    const timeslotRows = timeslots.map((startsAt) =>
      this.timeslotsRepository.create({ eventId: saved.id, startsAt: new Date(startsAt) }),
    );
    await this.timeslotsRepository.save(timeslotRows);

    const result = await this.findRawByIdOrThrow(saved.id);
    if (result.status === EventStatus.PUBLISHED) {
      void this.announceEvent(result);
    }
    return result;
  }

  async update(id: string, dto: UpdateEventDto, actorUserId?: string): Promise<Event> {
    const event = await this.findRawByIdOrThrow(id);
    const wasPublished = event.status === EventStatus.PUBLISHED;
    const { timeslots, fuelLimitPercent, tyreLimit, ...eventData } = dto;
    Object.assign(event, eventData);
    if (fuelLimitPercent !== undefined) event.fuelLimitPercent = toDecimalString(fuelLimitPercent) ?? null;
    if (tyreLimit !== undefined) event.tyreLimit = tyreLimit;
    await this.eventsRepository.save(event);

    if (timeslots) {
      await this.syncTimeslots(event, timeslots);
    }

    const result = await this.findRawByIdOrThrow(id);
    // Fuel/tyre limits, status and timeslots feed every team's plan page.
    this.planEvents?.emit(id, ALL_TEAMS, 'event', actorUserId);
    // Only the DRAFT/CANCELLED → PUBLISHED transition announces — re-saving an already-published
    // event (e.g. tweaking its description) must not re-post.
    if (!wasPublished && result.status === EventStatus.PUBLISHED) {
      void this.announceEvent(result);
    } else if (result.discordMessageId && (dto.status !== undefined || dto.signupDeadline !== undefined)) {
      // Status / deadline decide whether the post carries the Sign up buttons — refresh it.
      this.scheduleAnnouncementRefresh(id);
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
    if (limit <= 0) return [];
    // Filtered and limited in the DB (the events table keeps all history) — same "not finished yet"
    // rule as described above, evaluated in SQL.
    const events = await this.eventsRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.track', 'track')
      .where(`COALESCE("event"."ends_at", "event"."starts_at" + "event"."race_length_minutes" * interval '1 minute') >= :now`, {
        now: new Date(),
      })
      .orderBy('event.startsAt', 'ASC')
      .take(limit)
      .getMany();
    return events
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
  async findAllForViewer(isAdmin: boolean, viewerUserId?: string): Promise<(Event & { viewer: EventViewerStatus })[]> {
    const events = await this.eventsRepository.find({
      where: isAdmin ? {} : { status: Not(EventStatus.DRAFT) },
      relations: EVENT_RELATIONS,
      order: { startsAt: 'ASC' },
    });
    return withViewerStatus(events, await this.loadViewerSignups(viewerUserId, events));
  }

  /** The viewer's own signups for these events, in ONE query (not per event). */
  private async loadViewerSignups(viewerUserId: string | undefined, events: Event[]): Promise<ViewerSignupLike[]> {
    if (!viewerUserId || events.length === 0) return [];
    return this.signupsRepository.find({
      where: { userId: viewerUserId, eventId: In(events.map((e) => e.id)) },
      select: { id: true, eventId: true, status: true, eventTeamId: true },
    });
  }

  async findByIdForViewer(
    id: string,
    isAdmin: boolean,
    viewerUserId?: string,
  ): Promise<Event & { signups: EventSignup[]; viewer: EventViewerStatus }> {
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

    const viewerSignup = viewerUserId ? signups.find((s) => s.userId === viewerUserId) : undefined;
    return { ...event, signups, viewer: computeViewerStatus(event.status, viewerSignup) };
  }

  onModuleDestroy(): void {
    for (const timer of this.announcementTimers.values()) clearTimeout(timer);
    this.announcementTimers.clear();
  }

  /** Posts the announcement and remembers where it landed so the signup list can be edited in
   * place later. Best-effort — publishing never waits on or fails because of Discord. */
  private async announceEvent(event: Event): Promise<void> {
    try {
      const signups = await this.loadAnnouncementSignupsWithGuests(event.id);
      const ref = await this.discordBotService.postEventAnnouncement(event, signups);
      if (ref) {
        await this.eventsRepository.update(event.id, {
          discordChannelId: ref.channelId,
          discordMessageId: ref.messageId,
        });
      }
    } catch (err) {
      this.logger.warn(`Announcing event ${event.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Active (non-cancelled) signups in sign-up order, with each driver's display name — what the
   * Discord post lists. */
  private async loadAnnouncementSignups(eventId: string): Promise<AnnouncementSignup[]> {
    const signups = await this.signupsRepository.find({
      where: { eventId, status: Not(SignupStatus.CANCELLED) },
      order: { signedUpAt: 'ASC' },
    });
    if (signups.length === 0) return [];

    const profiles = await this.driverProfilesRepository.find({
      where: { userId: In(signups.map((s) => s.userId)) },
    });
    const names = new Map<string, string>();
    for (const profile of profiles) {
      if (profile.userId) names.set(profile.userId, profile.iracingName ?? profile.displayName);
    }
    return signups.map((s) => ({ name: names.get(s.userId) ?? 'Unknown driver', carClass: s.carClass }));
  }

  /** Members' and guests' active signups, guests flagged and listed after the members — what the
   * Discord post lists. The guest service depends on this one (circular), so it is resolved
   * lazily; a failure there only drops the guests from the post, never the post itself. */
  private async loadAnnouncementSignupsWithGuests(eventId: string): Promise<AnnouncementSignup[]> {
    const members = await this.loadAnnouncementSignups(eventId);
    if (!this.moduleRef) return members;
    try {
      const { EventGuestSignupsService } = await import('./event-guest-signups.service.js');
      const guestService = this.moduleRef.get(EventGuestSignupsService, { strict: false });
      const guests = await guestService.findActiveByEvent(eventId);
      if (guests.length === 0) return members;
      return [...members, ...guests.map((g) => ({ name: g.driverName, carClass: g.carClass, guest: true }))];
    } catch (err) {
      this.logger.warn(
        `Loading guest signups for the Discord post of event ${eventId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return members;
    }
  }

  /** Call after anything that changes who's signed up (or their class). Debounced per event. */
  private scheduleAnnouncementRefresh(eventId: string): void {
    const existing = this.announcementTimers.get(eventId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.announcementTimers.delete(eventId);
      void this.refreshAnnouncement(eventId);
    }, ANNOUNCEMENT_REFRESH_DEBOUNCE_MS);
    this.announcementTimers.set(eventId, timer);
  }

  /** Public entry point for sibling services (e.g. guest signups) whose changes also alter the
   * Discord post. Same debounce as member signups. */
  scheduleAnnouncementRefreshFor(eventId: string): void {
    this.scheduleAnnouncementRefresh(eventId);
  }

  private async refreshAnnouncement(eventId: string): Promise<void> {
    try {
      const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: EVENT_RELATIONS });
      // Never announced (or published before announcements were tracked): nothing to edit.
      if (!event?.discordMessageId || !event.discordChannelId) return;

      const signups = await this.loadAnnouncementSignupsWithGuests(eventId);
      const result = await this.discordBotService.updateEventAnnouncement(
        event,
        { channelId: event.discordChannelId, messageId: event.discordMessageId },
        signups,
      );
      if (result === 'gone') {
        await this.eventsRepository.update(eventId, { discordChannelId: null, discordMessageId: null });
      }
    } catch (err) {
      this.logger.warn(
        `Refreshing Discord announcement for event ${eventId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Saves a signup and queues a refresh of the event's Discord post. */
  private async saveSignup(signup: EventSignup, actorUserId?: string): Promise<EventSignup> {
    const saved = await this.signupsRepository.save(signup);
    this.scheduleAnnouncementRefresh(saved.eventId);
    // A signup only shows on the plan of the team it is placed on.
    if (saved.eventTeamId) this.planEvents?.emit(saved.eventId, saved.eventTeamId, 'drivers', actorUserId);
    return saved;
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
    const existing = await this.signupsRepository.findOne({
      where: { eventId, userId },
      relations: { timeslots: true },
    });

    // PUBLISHED is fully open (new signups, edits, re-activations). Once signups close — the
    // phase where teams get built and stints planned — a driver who's already in can keep
    // adjusting their own availability, but nobody new can join (and a cancelled signup can't
    // be revived), since the admin is now placing a fixed set of drivers onto teams.
    const isOpen = event.status === EventStatus.PUBLISHED;
    const isEditingActiveSignup =
      event.status === EventStatus.SIGNUPS_CLOSED && !!existing && existing.status !== SignupStatus.CANCELLED;
    if (!isOpen && !isEditingActiveSignup) {
      throw new ForbiddenException(
        event.status === EventStatus.SIGNUPS_CLOSED
          ? 'Signups are closed — only drivers already signed up can update their availability'
          : 'This event is not open for signups',
      );
    }

    const timeslots = await this.validateSignupChange(event, dto);

    if (existing) {
      existing.status = SignupStatus.CONFIRMED;
      this.applySignupFields(existing, dto, timeslots);
      return this.saveSignup(existing, userId);
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
      timeslotPreference: dto.timeslotPreference
        ? normalizeTimeslotPreference(dto.timeslotPreference, timeslots ?? [])
        : null,
    });
    return this.saveSignup(signup, userId);
  }

  /** Admin edit of another driver's signup (start times, car class, stint hours, notes) — same
   * field semantics as signup(), but keyed by the signup rather than the caller, with no event
   * status gate (an admin fixing availability mid team-building is the whole point) and without
   * touching the signup's own status, so editing a cancelled signup doesn't silently revive it. */
  async adminUpdateSignup(
    eventId: string,
    signupId: string,
    dto: SignupDto,
    actorUserId?: string,
  ): Promise<EventSignup> {
    const event = await this.findRawByIdOrThrow(eventId);
    const signup = await this.signupsRepository.findOne({
      where: { id: signupId, eventId },
      relations: { timeslots: true },
    });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }

    const timeslots = await this.validateSignupChange(event, dto);
    this.applySignupFields(signup, dto, timeslots);
    return this.saveSignup(signup, actorUserId);
  }

  /** Admin puts an approved member on an event (and, if given, straight onto one of its teams)
   * without the member signing up first — for filling a crew with someone who never visited the
   * signup page. No event-status gate, same as the other admin signup edits. Reactivates a
   * cancelled signup rather than colliding with it. When the team has a committed timeslot the
   * signup is tied to that start time, so the driver shows up in that team's availability grid
   * right away; with no hours set, planning treats them as free for any stint until someone
   * fills their availability in. */
  async adminAddSignup(eventId: string, dto: AdminAddSignupDto, actorUserId?: string): Promise<EventSignup> {
    const event = await this.findRawByIdOrThrow(eventId);

    const user = await this.usersRepository.findOne({ where: { id: dto.userId } });
    if (!user || user.status !== UserStatus.APPROVED) {
      throw new NotFoundException('Approved member not found');
    }

    let team: EventTeam | null = null;
    if (dto.eventTeamId) {
      team = await this.eventTeamsRepository.findOne({ where: { id: dto.eventTeamId, eventId } });
      if (!team) {
        throw new NotFoundException('Team not found for this event');
      }
    }
    const teamSlot = team?.timeslotId ? event.timeslots.find((slot) => slot.id === team.timeslotId) : undefined;

    const existing = await this.signupsRepository.findOne({
      where: { eventId, userId: dto.userId },
      relations: { timeslots: true },
    });
    if (existing && existing.status !== SignupStatus.CANCELLED) {
      throw new ConflictException('This member is already signed up for the event');
    }

    if (existing) {
      existing.status = SignupStatus.CONFIRMED;
      existing.eventTeamId = team?.id ?? null;
      if (teamSlot && existing.timeslots.length === 0) existing.timeslots = [teamSlot];
      return this.saveSignup(existing, actorUserId);
    }

    return this.saveSignup(
      this.signupsRepository.create({
        eventId,
        userId: dto.userId,
        status: SignupStatus.CONFIRMED,
        eventTeamId: team?.id ?? null,
        timeslots: teamSlot ? [teamSlot] : [],
        availableHours: [],
      }),
      actorUserId,
    );
  }

  /** Shared validation for signup() and adminUpdateSignup(); returns the resolved timeslot rows
   * when the dto sets them (ids from other events are silently dropped by the eventId filter). */
  private async validateSignupChange(event: Event, dto: SignupDto): Promise<EventTimeslot[] | undefined> {
    if (dto.carClass && !event.carClasses.includes(dto.carClass)) {
      throw new ForbiddenException('That car class is not offered for this event');
    }
    if (dto.secondaryCarClass && !event.carClasses.includes(dto.secondaryCarClass)) {
      throw new ForbiddenException('That secondary car class is not offered for this event');
    }
    if (dto.availableHours && !this.hoursFitEventTimeslots(dto.availableHours, event)) {
      throw new ForbiddenException("Availability hour doesn't fall within any of this event's timeslots");
    }

    if (dto.timeslotIds === undefined) return undefined;
    return dto.timeslotIds.length
      ? this.timeslotsRepository.find({ where: { id: In(dto.timeslotIds), eventId: event.id } })
      : [];
  }

  private applySignupFields(signup: EventSignup, dto: SignupDto, timeslots: EventTimeslot[] | undefined): void {
    if (dto.carId !== undefined) signup.carId = dto.carId;
    if (dto.carClass !== undefined) signup.carClass = dto.carClass;
    if (dto.secondaryCarClass !== undefined) signup.secondaryCarClass = dto.secondaryCarClass;
    if (dto.notes !== undefined) signup.notes = dto.notes;
    if (dto.availableHours !== undefined) signup.availableHours = dto.availableHours.map((h) => new Date(h));
    if (timeslots !== undefined) signup.timeslots = timeslots;

    // The ranking must always be a permutation of the chosen slots: re-normalise whenever the
    // ranking or the slots change; a signup that was never ranked stays null (chronological).
    const chosen = timeslots ?? signup.timeslots ?? [];
    if (dto.timeslotPreference === null) {
      signup.timeslotPreference = null;
    } else if (dto.timeslotPreference !== undefined) {
      signup.timeslotPreference = normalizeTimeslotPreference(dto.timeslotPreference, chosen);
    } else if (timeslots !== undefined && signup.timeslotPreference) {
      signup.timeslotPreference = normalizeTimeslotPreference(signup.timeslotPreference, chosen);
    }
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
  async assignSignupTeam(
    eventId: string,
    signupId: string,
    eventTeamId: string | null,
    actorUserId?: string,
  ): Promise<EventSignup> {
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
    const previousTeamId = signup.eventTeamId;
    signup.eventTeamId = eventTeamId;
    const saved = await this.signupsRepository.save(signup);
    if (previousTeamId && previousTeamId !== eventTeamId) await this.dropLead(previousTeamId, signup.userId);
    // Both crews' plans change: one loses the driver, the other gains them.
    for (const teamId of new Set([previousTeamId, eventTeamId])) {
      if (teamId) this.planEvents?.emit(eventId, teamId, 'drivers', actorUserId);
    }
    return saved;
  }

  async cancelSignup(eventId: string, userId: string): Promise<void> {
    const signup = await this.signupsRepository.findOne({ where: { eventId, userId } });
    if (!signup || signup.status === SignupStatus.CANCELLED) {
      throw new NotFoundException('No active signup found');
    }

    signup.status = SignupStatus.CANCELLED;
    await this.saveSignup(signup, userId);
    await this.dropLead(signup.eventTeamId, signup.userId);
  }

  async adminOverrideSignup(signupId: string, status: SignupStatus, actorUserId?: string): Promise<EventSignup> {
    const signup = await this.signupsRepository.findOne({ where: { id: signupId } });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }

    signup.status = status;
    const saved = await this.saveSignup(signup, actorUserId);
    if (status === SignupStatus.CANCELLED) await this.dropLead(signup.eventTeamId, signup.userId);
    return saved;
  }

  /** Hard delete, unlike cancelSignup/adminOverrideSignup which only flip status — for admins
   * clearing out a signup entirely rather than recording it as cancelled. */
  async deleteSignup(eventId: string, signupId: string, actorUserId?: string): Promise<void> {
    const existing = await this.signupsRepository.findOne({ where: { id: signupId, eventId } });
    const result = await this.signupsRepository.delete({ id: signupId, eventId });
    if (result.affected === 0) {
      throw new NotFoundException('Signup not found');
    }
    if (existing) await this.dropLead(existing.eventTeamId, existing.userId);
    this.scheduleAnnouncementRefresh(eventId);
    // The row is gone, so which team it sat on is unknown — nudge every crew of the event.
    this.planEvents?.emit(eventId, ALL_TEAMS, 'drivers', actorUserId);
  }
}
