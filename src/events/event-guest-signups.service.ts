import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { EventGuestSignup } from './event-guest-signup.entity.js';
import { EventTeamDummyDriversService } from './event-team-dummy-drivers.service.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { Event } from './event.entity.js';
import { EventsService } from './events.service.js';
import { ALL_TEAMS, TeamPlanEventsService } from './team-plan-events.service.js';
import { normalizeTimeslotPreference } from './timeslot-preference.js';

export interface GuestSignupInput {
  timeslotIds: string[];
  /** Undefined = keep the stored ranking (re-normalised), null = clear it, array = set it. */
  timeslotPreference?: string[] | null;
  /** Undefined = leave unchanged, null = clear, string = set (must be one of the event's classes). */
  carClass?: string | null;
}

export type GuestSignupWithName = EventGuestSignup & { driverName: string };

/** What the portal gets (GET /events/:id `guestSignups`, GET /events/:id/guest-signups). */
export type GuestSignupView = GuestSignupWithName & {
  avatarUrl: string | null;
  /** Placed on one of the event's teams (as a roster guest). */
  onTeam: boolean;
  eventTeamId: string | null;
};

/** Signups of guest drivers (manual DriverProfiles with no portal account) — see
 * EventGuestSignup. The Discord bot calls upsert()/cancel() on their behalf. */
@Injectable()
export class EventGuestSignupsService {
  constructor(
    @InjectRepository(EventGuestSignup)
    private readonly guestSignupsRepository: Repository<EventGuestSignup>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(EventTeamDummyDriver)
    private readonly dummiesRepository: Repository<EventTeamDummyDriver>,
    private readonly eventsService: EventsService,
    private readonly dummyDriversService: EventTeamDummyDriversService,
    @Optional() private readonly planEvents?: TeamPlanEventsService,
  ) {}

  /** Creates or updates (and re-activates a cancelled) guest signup. Idempotent: the same input
   * twice leaves one row. Same openness rule as member signups (EventsService.signup): fully open
   * while PUBLISHED; once signups close only a guest who is already in may adjust their slots. */
  async upsert(eventId: string, driverProfileId: string, input: GuestSignupInput): Promise<EventGuestSignup> {
    const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: { timeslots: true } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const existing = await this.guestSignupsRepository.findOne({ where: { eventId, driverProfileId } });

    const isOpen = event.status === EventStatus.PUBLISHED;
    const isEditingActiveSignup =
      event.status === EventStatus.SIGNUPS_CLOSED && !!existing && existing.status !== 'CANCELLED';
    if (!isOpen && !isEditingActiveSignup) {
      throw new ForbiddenException(
        event.status === EventStatus.SIGNUPS_CLOSED
          ? 'Signups are closed — only drivers already signed up can update their availability'
          : 'This event is not open for signups',
      );
    }

    const profile = await this.driverProfilesRepository.findOne({ where: { id: driverProfileId } });
    if (!profile) {
      throw new NotFoundException('Driver not found');
    }
    if (profile.userId !== null) {
      throw new BadRequestException('This driver has a portal account — they sign up as a member instead');
    }

    const timeslotIds = [...new Set(input.timeslotIds ?? [])];
    if (timeslotIds.length === 0) {
      throw new BadRequestException('Pick at least one start time');
    }
    const eventSlots = event.timeslots ?? [];
    const chosen = timeslotIds.map((id) => eventSlots.find((slot) => slot.id === id));
    if (chosen.some((slot) => slot === undefined)) {
      throw new BadRequestException("One of the start times doesn't belong to this event");
    }
    const chosenSlots = chosen as NonNullable<(typeof chosen)[number]>[];

    if (input.carClass && !event.carClasses.includes(input.carClass)) {
      throw new BadRequestException('That car class is not offered for this event');
    }

    let timeslotPreference: string[] | null;
    if (input.timeslotPreference === null) {
      timeslotPreference = null;
    } else if (input.timeslotPreference !== undefined) {
      timeslotPreference = normalizeTimeslotPreference(input.timeslotPreference, chosenSlots);
    } else if (existing?.timeslotPreference) {
      timeslotPreference = normalizeTimeslotPreference(existing.timeslotPreference, chosenSlots);
    } else {
      timeslotPreference = null;
    }

    const signup =
      existing ??
      this.guestSignupsRepository.create({ eventId, driverProfileId, carClass: null, status: 'CONFIRMED' });
    signup.status = 'CONFIRMED';
    signup.timeslotIds = timeslotIds;
    signup.timeslotPreference = timeslotPreference;
    if (input.carClass !== undefined) signup.carClass = input.carClass;

    let saved: EventGuestSignup;
    try {
      saved = await this.guestSignupsRepository.save(signup);
    } catch (err) {
      // Two simultaneous first signups for the same guest: the loser hits the unique index.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('Your signup was changed at the same time — please try again');
      }
      throw err;
    }
    this.afterChange(eventId);
    return saved;
  }

  /** Marks the signup CANCELLED. Silent when the guest has none (or it is already cancelled). */
  async cancel(eventId: string, driverProfileId: string, actorUserId?: string): Promise<void> {
    const signup = await this.guestSignupsRepository.findOne({ where: { eventId, driverProfileId } });
    if (!signup || signup.status === 'CANCELLED') return;
    signup.status = 'CANCELLED';
    await this.guestSignupsRepository.save(signup);
    this.afterChange(eventId, actorUserId);
  }

  /** CONFIRMED guest signups of the event in sign-up order, each with `driverName`
   * (iracingName ?? displayName). */
  async findActiveByEvent(eventId: string): Promise<GuestSignupWithName[]> {
    const signups = await this.loadActive(eventId);
    const profiles = await this.loadProfiles(signups);
    return signups.map((signup) => ({ ...signup, driverName: this.nameOf(profiles.get(signup.driverProfileId)) }));
  }

  findByEventAndProfile(eventId: string, driverProfileId: string): Promise<EventGuestSignup | null> {
    return this.guestSignupsRepository.findOne({ where: { eventId, driverProfileId } });
  }

  /** findActiveByEvent plus portal-facing extras: avatar and whether the guest is already on a team. */
  async listViewsForEvent(eventId: string): Promise<GuestSignupView[]> {
    const signups = await this.loadActive(eventId);
    if (signups.length === 0) return [];
    const profiles = await this.loadProfiles(signups);
    const placements = await this.dummiesRepository
      .createQueryBuilder('d')
      .innerJoin('d.eventTeam', 't')
      .where('t.eventId = :eventId AND d.driverProfileId IN (:...ids)', {
        eventId,
        ids: signups.map((s) => s.driverProfileId),
      })
      .getMany();
    const teamByProfile = new Map<string, string>();
    for (const placement of placements) {
      if (placement.driverProfileId) teamByProfile.set(placement.driverProfileId, placement.eventTeamId);
    }
    return signups.map((signup) => {
      const profile = profiles.get(signup.driverProfileId);
      const eventTeamId = teamByProfile.get(signup.driverProfileId) ?? null;
      return {
        ...signup,
        driverName: this.nameOf(profile),
        avatarUrl: profile?.avatarUrl ?? null,
        onTeam: eventTeamId !== null,
        eventTeamId,
      };
    });
  }

  /** Admin: puts an actively signed-up guest on a team as a roster guest (an
   * EventTeamDummyDriver with the driver's profile id and no availability restriction). A guest
   * already on a team of this event is refused with 409 by the dummy-driver service. */
  async placeOnTeam(
    eventId: string,
    driverProfileId: string,
    eventTeamId: string,
    actorUserId?: string,
  ): Promise<EventTeamDummyDriver> {
    const signup = await this.guestSignupsRepository.findOne({ where: { eventId, driverProfileId } });
    if (!signup || signup.status === 'CANCELLED') {
      throw new NotFoundException('No active guest signup found');
    }
    return this.dummyDriversService.create(eventId, eventTeamId, { driverProfileId }, actorUserId);
  }

  private loadActive(eventId: string): Promise<EventGuestSignup[]> {
    return this.guestSignupsRepository.find({
      where: { eventId, status: 'CONFIRMED' },
      order: { signedUpAt: 'ASC' },
    });
  }

  private async loadProfiles(signups: EventGuestSignup[]): Promise<Map<string, DriverProfile>> {
    if (signups.length === 0) return new Map();
    const profiles = await this.driverProfilesRepository.find({
      where: { id: In(signups.map((s) => s.driverProfileId)) },
    });
    return new Map(profiles.map((p) => [p.id, p]));
  }

  private nameOf(profile: DriverProfile | undefined): string {
    return profile ? (profile.iracingName ?? profile.displayName) : 'Unknown driver';
  }

  /** A guest signup is a planning input for every crew of the event and changes the Discord post. */
  private afterChange(eventId: string, actorUserId?: string): void {
    this.planEvents?.emit(eventId, ALL_TEAMS, 'drivers', actorUserId);
    this.eventsService.scheduleAnnouncementRefreshFor(eventId);
  }
}
