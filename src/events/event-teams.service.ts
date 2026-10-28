import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { toDecimalString } from '../common/decimal.util.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { CreateEventTeamDto } from './dto/create-event-team.dto.js';
import { UpdateEventTeamDto } from './dto/update-event-team.dto.js';
import { EventTeam } from './event-team.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { TeamPlanEventsService } from './team-plan-events.service.js';

/** An event team as returned by the read endpoints: plus the id of its linked race result (the
 * latest one), null until a result has been matched to it — see ResultEventLinkService. */
export type EventTeamWithResult = EventTeam & { raceResultId: string | null };

const DECIMAL_FIELD_KEYS = [
  'refuelDurationSeconds',
  'tyreChangeDurationSeconds',
  'partialTyreChangeSeconds',
  'pitstopDrivethroughSeconds',
  'lapTimeDrySeconds',
  'lapTimeWetSeconds',
  'fuelUsagePerLapLiters',
  'raceStartOffsetMinutes',
  'formationLapFuelLiters',
  'fuelTankCapacityLiters',
] as const;
type DecimalFieldKey = (typeof DECIMAL_FIELD_KEYS)[number];

@Injectable()
export class EventTeamsService {
  constructor(
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTimeslot)
    private readonly timeslotsRepository: Repository<EventTimeslot>,
    @Optional() private readonly planEvents?: TeamPlanEventsService,
    @Optional()
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository?: Repository<RaceResult>,
  ) {}

  async listForEvent(eventId: string): Promise<EventTeamWithResult[]> {
    const teams = await this.teamsRepository.find({
      where: { eventId },
      relations: { dummyDrivers: true },
      order: { createdAt: 'ASC' },
    });
    return this.withRaceResultIds(teams);
  }

  /** Adds `raceResultId` (additive) from race_results.event_team_id; when several results are
   * linked to one team the latest (by session start) wins. */
  private async withRaceResultIds(teams: EventTeam[]): Promise<EventTeamWithResult[]> {
    const latestByTeam = new Map<string, string>();
    if (this.raceResultsRepository && teams.length > 0) {
      const rows = await this.raceResultsRepository.find({
        where: { eventTeamId: In(teams.map((team) => team.id)) },
        select: { id: true, eventTeamId: true, startTime: true, createdAt: true },
        order: { startTime: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC' },
      });
      for (const row of rows) {
        if (row.eventTeamId && !latestByTeam.has(row.eventTeamId)) latestByTeam.set(row.eventTeamId, row.id);
      }
    }
    return teams.map((team) => Object.assign(team, { raceResultId: latestByTeam.get(team.id) ?? null }));
  }

  /** One team of the event with its guest/dummy drivers — the same shape as an element of
   * listForEvent(), without loading the event's other teams. 404 when the team is not in the event. */
  async findOneForEvent(eventId: string, teamId: string): Promise<EventTeamWithResult> {
    const team = await this.teamsRepository.findOne({
      where: { id: teamId, eventId },
      relations: { dummyDrivers: true },
    });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    const [withResult] = await this.withRaceResultIds([team]);
    return withResult;
  }

  async create(eventId: string, dto: CreateEventTeamDto): Promise<EventTeam> {
    await this.checkTimeslotBelongsToEvent(eventId, dto.timeslotId);
    const team = this.teamsRepository.create({
      eventId,
      name: dto.name,
      carId: dto.carId,
      iracingTeamId: dto.iracingTeamId,
      timeslotId: dto.timeslotId,
      simStartTimeOfDay: dto.simStartTimeOfDay,
      ...this.decimalFields(dto),
    });
    return this.teamsRepository.save(team);
  }

  async update(eventId: string, teamId: string, dto: UpdateEventTeamDto, actorUserId?: string): Promise<EventTeam> {
    const team = await this.findOrThrow(eventId, teamId);
    await this.checkTimeslotBelongsToEvent(eventId, dto.timeslotId);
    if (dto.name !== undefined) team.name = dto.name;
    if (dto.carId !== undefined) team.carId = dto.carId;
    if (dto.iracingTeamId !== undefined) team.iracingTeamId = dto.iracingTeamId;
    if (dto.timeslotId !== undefined) team.timeslotId = dto.timeslotId;
    if (dto.simStartTimeOfDay !== undefined) team.simStartTimeOfDay = dto.simStartTimeOfDay;
    Object.assign(team, this.decimalFields(dto));
    const saved = await this.teamsRepository.save(team);
    this.planEvents?.emit(eventId, teamId, 'team', actorUserId);
    return saved;
  }

  /** A team's chosen timeslot must belong to the same event — guards against a stray/forged id
   * the same way EventsService.assignSignupTeam() guards a signup's team assignment. Undefined
   * (untouched) and null (clearing) both skip the check. */
  private async checkTimeslotBelongsToEvent(eventId: string, timeslotId: string | null | undefined): Promise<void> {
    if (!timeslotId) return;
    const timeslot = await this.timeslotsRepository.findOne({ where: { id: timeslotId, eventId } });
    if (!timeslot) {
      throw new NotFoundException('Timeslot not found for this event');
    }
  }

  async remove(eventId: string, teamId: string, actorUserId?: string): Promise<void> {
    const team = await this.findOrThrow(eventId, teamId);
    await this.teamsRepository.remove(team);
    this.planEvents?.emit(eventId, teamId, 'team', actorUserId);
  }

  /** Only includes a key when the dto actually carries it — a key present with value `undefined`
   * (rather than simply absent) still gets copied by Object.assign/spread and, per TypeORM's
   * save(), still overwrites the column to NULL, silently clobbering a value the caller never
   * touched. Confirmed with a real round-trip check before this fix caught exactly that bug. */
  private decimalFields(dto: CreateEventTeamDto | UpdateEventTeamDto): Partial<Record<DecimalFieldKey, string | null>> {
    const result: Partial<Record<DecimalFieldKey, string | null>> = {};
    for (const key of DECIMAL_FIELD_KEYS) {
      if (dto[key] !== undefined) {
        result[key] = toDecimalString(dto[key]);
      }
    }
    return result;
  }

  private async findOrThrow(eventId: string, teamId: string): Promise<EventTeam> {
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    return team;
  }
}
