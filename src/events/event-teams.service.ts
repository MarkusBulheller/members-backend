import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toDecimalString } from '../common/decimal.util.js';
import { CreateEventTeamDto } from './dto/create-event-team.dto.js';
import { UpdateEventTeamDto } from './dto/update-event-team.dto.js';
import { EventTeam } from './event-team.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';

const DECIMAL_FIELD_KEYS = [
  'refuelDurationSeconds',
  'tyreChangeDurationSeconds',
  'pitstopDrivethroughSeconds',
  'lapTimeDrySeconds',
  'lapTimeWetSeconds',
  'fuelUsagePerLapLiters',
  'raceStartOffsetMinutes',
  'formationLapFuelLiters',
] as const;
type DecimalFieldKey = (typeof DECIMAL_FIELD_KEYS)[number];

@Injectable()
export class EventTeamsService {
  constructor(
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTimeslot)
    private readonly timeslotsRepository: Repository<EventTimeslot>,
  ) {}

  listForEvent(eventId: string): Promise<EventTeam[]> {
    return this.teamsRepository.find({ where: { eventId }, order: { createdAt: 'ASC' } });
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

  async update(eventId: string, teamId: string, dto: UpdateEventTeamDto): Promise<EventTeam> {
    const team = await this.findOrThrow(eventId, teamId);
    await this.checkTimeslotBelongsToEvent(eventId, dto.timeslotId);
    if (dto.name !== undefined) team.name = dto.name;
    if (dto.carId !== undefined) team.carId = dto.carId;
    if (dto.iracingTeamId !== undefined) team.iracingTeamId = dto.iracingTeamId;
    if (dto.timeslotId !== undefined) team.timeslotId = dto.timeslotId;
    if (dto.simStartTimeOfDay !== undefined) team.simStartTimeOfDay = dto.simStartTimeOfDay;
    Object.assign(team, this.decimalFields(dto));
    return this.teamsRepository.save(team);
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

  async remove(eventId: string, teamId: string): Promise<void> {
    const team = await this.findOrThrow(eventId, teamId);
    await this.teamsRepository.remove(team);
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
