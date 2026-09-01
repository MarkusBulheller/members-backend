import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toDecimalString } from '../common/decimal.util.js';
import { UpsertEventTeamDriverSettingsDto } from './dto/upsert-event-team-driver-settings.dto.js';
import { EventTeamDriverSettings } from './event-team-driver-settings.entity.js';
import { EventTeam } from './event-team.entity.js';

@Injectable()
export class EventTeamDriverSettingsService {
  constructor(
    @InjectRepository(EventTeamDriverSettings)
    private readonly settingsRepository: Repository<EventTeamDriverSettings>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
  ) {}

  async listForTeam(eventId: string, teamId: string): Promise<EventTeamDriverSettings[]> {
    await this.findTeamOrThrow(eventId, teamId);
    return this.settingsRepository.find({ where: { eventTeamId: teamId } });
  }

  async upsert(
    eventId: string,
    teamId: string,
    userId: string,
    dto: UpsertEventTeamDriverSettingsDto,
  ): Promise<EventTeamDriverSettings> {
    await this.findTeamOrThrow(eventId, teamId);
    let settings = await this.settingsRepository.findOne({ where: { eventTeamId: teamId, userId } });
    if (!settings) {
      settings = this.settingsRepository.create({ eventTeamId: teamId, userId });
    }
    if (dto.lapTimeDrySeconds !== undefined) settings.lapTimeDrySeconds = toDecimalString(dto.lapTimeDrySeconds) ?? null;
    if (dto.lapTimeWetSeconds !== undefined) settings.lapTimeWetSeconds = toDecimalString(dto.lapTimeWetSeconds) ?? null;
    if (dto.fuelUsagePerLapLiters !== undefined) {
      settings.fuelUsagePerLapLiters = toDecimalString(dto.fuelUsagePerLapLiters) ?? null;
    }
    return this.settingsRepository.save(settings);
  }

  private async findTeamOrThrow(eventId: string, teamId: string): Promise<EventTeam> {
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    return team;
  }
}
