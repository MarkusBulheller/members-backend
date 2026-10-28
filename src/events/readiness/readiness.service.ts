import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Car } from '../../cars/car.entity.js';
import { EventStatus } from '../../common/enums/event-status.enum.js';
import { Sim } from '../../common/enums/sim.enum.js';
import { SignupStatus } from '../../common/enums/signup-status.enum.js';
import { DriverProfile } from '../../drivers/driver-profile.entity.js';
import { IracingSeriesService } from '../../iracing/iracing-series.service.js';
import { IracingTeamMember } from '../../iracing/iracing-team-member.entity.js';
import { User } from '../../users/user.entity.js';
import { EventGuestSignup } from '../event-guest-signup.entity.js';
import { EventSignup } from '../event-signup.entity.js';
import { EventTeamDriverSettings } from '../event-team-driver-settings.entity.js';
import { EventTeamDummyDriver } from '../event-team-dummy-driver.entity.js';
import { EventTeamStint } from '../event-team-stint.entity.js';
import { EventTeam } from '../event-team.entity.js';
import { Event } from '../event.entity.js';
import { evaluateEventReadiness, restrictReadinessToTeams } from './readiness.rules.js';
import type {
  ReadinessDriverProfile,
  ReadinessForecastInput,
  ReadinessInput,
  ReadinessResult,
} from './readiness.types.js';

/** The forecast is a presigned-S3 download on top of everything else; never let it hold the endpoint up. */
const FORECAST_TIMEOUT_MS = 4000;

const UNKNOWN_DRIVER = 'Unknown driver';

function profileName(p: DriverProfile): string {
  return p.iracingName ?? p.displayName;
}

function toReadinessProfile(p: DriverProfile): ReadinessDriverProfile {
  return {
    name: profileName(p),
    iracingCustomerId: p.iracingCustomerId,
    maxSuccessiveStints: p.maxSuccessiveStints,
    startingDriver: p.startingDriver,
    nightDriver: p.nightDriver,
  };
}

/** Loads everything the race-readiness rules need with a fixed number of batched queries (no
 * per-team or per-driver round trips) and hands it to the pure engine. */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    @InjectRepository(Event) private readonly eventsRepository: Repository<Event>,
    @InjectRepository(EventTeam) private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint) private readonly stintsRepository: Repository<EventTeamStint>,
    @InjectRepository(EventTeamDriverSettings)
    private readonly driverSettingsRepository: Repository<EventTeamDriverSettings>,
    @InjectRepository(EventTeamDummyDriver) private readonly dummiesRepository: Repository<EventTeamDummyDriver>,
    @InjectRepository(EventSignup) private readonly signupsRepository: Repository<EventSignup>,
    @InjectRepository(EventGuestSignup) private readonly guestSignupsRepository: Repository<EventGuestSignup>,
    @InjectRepository(DriverProfile) private readonly profilesRepository: Repository<DriverProfile>,
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Car) private readonly carsRepository: Repository<Car>,
    @InjectRepository(IracingTeamMember) private readonly rosterRepository: Repository<IracingTeamMember>,
    private readonly seriesService: IracingSeriesService,
  ) {}

  /** Admin: everything. Member: only the teams they are signed up on, no event-level checks. A
   * DRAFT event does not exist for members (404), same as the event detail route. */
  async getReadiness(eventId: string, isAdmin: boolean, viewerUserId: string): Promise<ReadinessResult> {
    const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: { timeslots: true } });
    if (!event || (!isAdmin && event.status === EventStatus.DRAFT)) {
      throw new NotFoundException('Event not found');
    }

    const input = await this.loadInput(event);
    const result = evaluateEventReadiness(input);
    if (isAdmin) return result;

    const myTeamIds = new Set(
      input.signups.flatMap((s) => (s.userId === viewerUserId && s.status !== 'CANCELLED' && s.eventTeamId ? [s.eventTeamId] : [])),
    );
    return restrictReadinessToTeams(result, myTeamIds);
  }

  private async loadInput(event: Event): Promise<ReadinessInput> {
    const teams = await this.teamsRepository.find({ where: { eventId: event.id }, order: { createdAt: 'ASC' } });
    const teamIds = teams.map((t) => t.id);
    const carIds = [...new Set(teams.flatMap((t) => (t.carId ? [t.carId] : [])))];
    const iracingTeamIds = [...new Set(teams.flatMap((t) => (t.iracingTeamId !== null ? [t.iracingTeamId] : [])))];
    const hasTeams = teamIds.length > 0;

    const [signups, guestSignups, dummies, stints, driverSettings, cars, rosterRows] = await Promise.all([
      this.signupsRepository.find({ where: { eventId: event.id }, order: { signedUpAt: 'ASC' } }),
      this.guestSignupsRepository.find({ where: { eventId: event.id, status: 'CONFIRMED' }, order: { signedUpAt: 'ASC' } }),
      hasTeams ? this.dummiesRepository.find({ where: { eventTeamId: In(teamIds) }, order: { createdAt: 'ASC' } }) : [],
      hasTeams ? this.stintsRepository.find({ where: { eventTeamId: In(teamIds) }, order: { order: 'ASC' } }) : [],
      hasTeams ? this.driverSettingsRepository.find({ where: { eventTeamId: In(teamIds) } }) : [],
      carIds.length > 0
        ? this.carsRepository.find({ where: { id: In(carIds) }, select: { id: true, tankCapacityLiters: true } })
        : [],
      iracingTeamIds.length > 0 ? this.rosterRepository.find({ where: { teamId: In(iracingTeamIds) } }) : [],
    ]);

    // Driver profiles for every real person that can appear: signups, stint drivers, roster guests.
    const userIds = [
      ...new Set([
        ...signups.map((s) => s.userId),
        ...stints.flatMap((s) => (s.driverUserId ? [s.driverUserId] : [])),
      ]),
    ];
    const profileIds = [
      ...new Set([
        ...dummies.flatMap((d) => (d.driverProfileId ? [d.driverProfileId] : [])),
        ...guestSignups.map((g) => g.driverProfileId),
      ]),
    ];
    const profiles = await this.loadProfiles(userIds, profileIds);
    const profileByUserId = new Map(profiles.flatMap((p) => (p.userId ? [[p.userId, p] as const] : [])));
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    // A member without a driver profile still gets a readable name from their Discord account.
    const missingNameIds = userIds.filter((id) => !profileByUserId.has(id));
    const users =
      missingNameIds.length > 0
        ? await this.usersRepository.find({
            where: { id: In(missingNameIds) },
            select: { id: true, discordGlobalName: true, discordUsername: true },
          })
        : [];
    const userNameById = new Map(users.map((u) => [u.id, u.discordGlobalName ?? u.discordUsername]));
    const nameForUser = (id: string): string => {
      const profile = profileByUserId.get(id);
      return profile ? profileName(profile) : (userNameById.get(id) ?? UNKNOWN_DRIVER);
    };
    const profileForUser = (id: string): ReadinessDriverProfile | null => {
      const profile = profileByUserId.get(id);
      return profile ? toReadinessProfile(profile) : null;
    };

    const driverNames: Record<string, string> = {};
    for (const id of userIds) driverNames[id] = nameForUser(id);
    for (const d of dummies) driverNames[d.id] = d.name;

    const carTankById = new Map(cars.map((c) => [c.id, c.tankCapacityLiters]));
    const rosters: Record<number, number[]> = {};
    for (const row of rosterRows) (rosters[row.teamId] ??= []).push(row.custId);

    const byTeam = <T extends { eventTeamId: string }>(rows: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.eventTeamId, [...(map.get(row.eventTeamId) ?? []), row]);
      return map;
    };
    const dummiesByTeam = byTeam(dummies);
    const stintsByTeam = byTeam(stints);
    const settingsByTeam = byTeam(driverSettings);
    const membersByTeam = byTeam(signups.filter((s) => s.eventTeamId !== null && s.status !== SignupStatus.CANCELLED) as (EventSignup & { eventTeamId: string })[]);

    return {
      now: new Date(),
      event: {
        id: event.id,
        sim: event.sim,
        raceLengthMinutes: event.raceLengthMinutes,
        minDriversPerTeam: event.minDriversPerTeam,
        fuelLimitPercent: event.fuelLimitPercent,
        tyreLimit: event.tyreLimit,
        iracingSeasonId: event.iracingSeasonId,
        iracingRaceWeekNum: event.iracingRaceWeekNum,
      },
      timeslots: (event.timeslots ?? []).map((t) => ({ id: t.id, startsAt: t.startsAt })),
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        carId: team.carId,
        iracingTeamId: team.iracingTeamId,
        timeslotId: team.timeslotId,
        refuelDurationSeconds: team.refuelDurationSeconds,
        tyreChangeDurationSeconds: team.tyreChangeDurationSeconds,
        partialTyreChangeSeconds: team.partialTyreChangeSeconds,
        pitstopDrivethroughSeconds: team.pitstopDrivethroughSeconds,
        fuelTankCapacityLiters: team.fuelTankCapacityLiters,
        lapTimeDrySeconds: team.lapTimeDrySeconds,
        lapTimeWetSeconds: team.lapTimeWetSeconds,
        fuelUsagePerLapLiters: team.fuelUsagePerLapLiters,
        raceStartOffsetMinutes: team.raceStartOffsetMinutes,
        formationLapFuelLiters: team.formationLapFuelLiters,
        carTankCapacityLiters: team.carId ? (carTankById.get(team.carId) ?? null) : null,
        members: (membersByTeam.get(team.id) ?? []).map((s) => ({
          userId: s.userId,
          name: nameForUser(s.userId),
          availableHours: s.availableHours ?? [],
          profile: profileForUser(s.userId),
        })),
        dummies: (dummiesByTeam.get(team.id) ?? []).map((d) => {
          const profile = d.driverProfileId ? profileById.get(d.driverProfileId) : undefined;
          return {
            id: d.id,
            // The roster's current name wins over the snapshot taken when the guest was added.
            name: profile ? profileName(profile) : d.name,
            driverProfileId: d.driverProfileId,
            availableHours: d.availableHours ?? [],
            profile: profile ? toReadinessProfile(profile) : null,
          };
        }),
        stints: (stintsByTeam.get(team.id) ?? []).map((s) => ({
          id: s.id,
          order: s.order,
          driverUserId: s.driverUserId,
          durationMinutes: s.durationMinutes,
          tyreChange: s.tyreChange,
          tyresChanged: s.tyresChanged,
          actualStartAt: s.actualStartAt,
          wetOverride: s.wetOverride,
        })),
        driverSettings: (settingsByTeam.get(team.id) ?? []).map((s) => ({
          userId: s.userId,
          lapTimeDrySeconds: s.lapTimeDrySeconds,
          lapTimeWetSeconds: s.lapTimeWetSeconds,
          fuelUsagePerLapLiters: s.fuelUsagePerLapLiters,
        })),
      })),
      signups: signups.map((s) => ({
        userId: s.userId,
        name: nameForUser(s.userId),
        status: s.status,
        eventTeamId: s.eventTeamId,
      })),
      guestSignups: guestSignups.map((g) => {
        const profile = profileById.get(g.driverProfileId);
        return { driverProfileId: g.driverProfileId, name: profile ? profileName(profile) : UNKNOWN_DRIVER };
      }),
      rosters,
      driverNames,
      forecast: await this.loadForecast(event, stints.length > 0),
    };
  }

  private async loadProfiles(userIds: string[], profileIds: string[]): Promise<DriverProfile[]> {
    const where = [
      ...(userIds.length > 0 ? [{ userId: In(userIds) }] : []),
      ...(profileIds.length > 0 ? [{ id: In(profileIds) }] : []),
    ];
    return where.length > 0 ? this.profilesRepository.find({ where }) : [];
  }

  /** Best-effort: only for an iRacing event linked to a week and with something to check; any
   * failure (expired link, timeout, no data) becomes UNAVAILABLE so the night check goes PENDING
   * instead of the endpoint failing. */
  private async loadForecast(event: Event, anyStints: boolean): Promise<ReadinessForecastInput | null> {
    if (event.sim !== Sim.IRACING || event.iracingSeasonId === null || event.iracingRaceWeekNum === null) return null;
    if (!anyStints) return { state: 'UNAVAILABLE', reason: 'No stints planned yet.' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const points = await Promise.race([
        this.seriesService.getWeatherForecast(event.iracingSeasonId, event.iracingRaceWeekNum),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), FORECAST_TIMEOUT_MS);
        }),
      ]);
      return {
        state: 'OK',
        points: points.flatMap((p) => {
          const point = p as Record<string, unknown>;
          return typeof point?.time_offset === 'number' && typeof point?.is_sun_up === 'boolean'
            ? [{ time_offset: point.time_offset, is_sun_up: point.is_sun_up }]
            : [];
        }),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`Readiness: forecast unavailable for event ${event.id}: ${reason}`);
      return { state: 'UNAVAILABLE', reason };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
