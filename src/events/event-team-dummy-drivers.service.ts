import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { CreateEventTeamDummyDriverDto } from './dto/create-event-team-dummy-driver.dto.js';
import { UpdateEventTeamDummyDriverDto } from './dto/update-event-team-dummy-driver.dto.js';
import { EventTeamDriverSettings } from './event-team-driver-settings.entity.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeam } from './event-team.entity.js';
import { TeamPlanEventsService } from './team-plan-events.service.js';

@Injectable()
export class EventTeamDummyDriversService {
  constructor(
    @InjectRepository(EventTeamDummyDriver)
    private readonly dummiesRepository: Repository<EventTeamDummyDriver>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
    @InjectRepository(EventTeamStint)
    private readonly stintsRepository: Repository<EventTeamStint>,
    @InjectRepository(EventTeamDriverSettings)
    private readonly settingsRepository: Repository<EventTeamDriverSettings>,
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @Optional() private readonly planEvents?: TeamPlanEventsService,
  ) {}

  async list(eventId: string, teamId: string): Promise<EventTeamDummyDriver[]> {
    await this.assertTeam(eventId, teamId);
    return this.dummiesRepository.find({ where: { eventTeamId: teamId }, order: { createdAt: 'ASC' } });
  }

  async create(
    eventId: string,
    teamId: string,
    dto: CreateEventTeamDummyDriverDto,
    actorUserId?: string,
  ): Promise<EventTeamDummyDriver> {
    await this.assertTeam(eventId, teamId);

    let name = dto.name?.trim() ?? '';
    let driverProfileId: string | null = null;

    if (dto.driverProfileId) {
      const profile = await this.driverProfilesRepository.findOne({ where: { id: dto.driverProfileId } });
      if (!profile) {
        throw new NotFoundException('Driver not found');
      }
      // A driver with a portal account is added through a real signup (it carries their own
      // availability and shows on their dashboard) — this entity is for people without one.
      if (profile.userId !== null) {
        throw new BadRequestException('This driver has a portal account — add them as a member instead');
      }
      // The same guest can't sit on two crews of one event.
      const alreadyInEvent = await this.dummiesRepository
        .createQueryBuilder('d')
        .innerJoin('d.eventTeam', 't')
        .where('t.eventId = :eventId AND d.driverProfileId = :profileId', { eventId, profileId: profile.id })
        .getExists();
      if (alreadyInEvent) {
        throw new ConflictException('This driver is already on a team in this event');
      }
      name = profile.iracingName ?? profile.displayName;
      driverProfileId = profile.id;
    }

    if (!name) {
      throw new BadRequestException('Provide a name or a roster driver');
    }
    const saved = await this.dummiesRepository.save(
      this.dummiesRepository.create({ eventTeamId: teamId, name, driverProfileId, availableHours: [] }),
    );
    this.planEvents?.emit(eventId, teamId, 'drivers', actorUserId);
    return saved;
  }

  async update(
    eventId: string,
    teamId: string,
    dummyId: string,
    dto: UpdateEventTeamDummyDriverDto,
    actorUserId?: string,
  ): Promise<EventTeamDummyDriver> {
    const dummy = await this.findOrThrow(eventId, teamId, dummyId);
    if (dto.name !== undefined) dummy.name = dto.name.trim();
    if (dto.availableHours !== undefined) dummy.availableHours = dto.availableHours.map((h) => new Date(h));
    const saved = await this.dummiesRepository.save(dummy);
    this.planEvents?.emit(eventId, teamId, 'drivers', actorUserId);
    return saved;
  }

  /** Stints and driver settings reference a dummy by plain id with no FK (same as real drivers),
   * so nothing cascades from the row delete — clear them here: stints go back to unassigned
   * rather than being deleted, the per-driver pace/fuel row has no meaning without the driver. */
  async remove(eventId: string, teamId: string, dummyId: string, actorUserId?: string): Promise<void> {
    const dummy = await this.findOrThrow(eventId, teamId, dummyId);
    await this.stintsRepository.update({ eventTeamId: teamId, driverUserId: dummyId }, { driverUserId: null });
    await this.settingsRepository.delete({ eventTeamId: teamId, userId: dummyId });
    await this.dummiesRepository.remove(dummy);
    // Its stints went back to unassigned too, so the stint list changed as well.
    this.planEvents?.emit(eventId, teamId, 'drivers', actorUserId);
    this.planEvents?.emit(eventId, teamId, 'stints', actorUserId);
  }

  private async assertTeam(eventId: string, teamId: string): Promise<void> {
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
  }

  private async findOrThrow(eventId: string, teamId: string, dummyId: string): Promise<EventTeamDummyDriver> {
    await this.assertTeam(eventId, teamId);
    const dummy = await this.dummiesRepository.findOne({ where: { id: dummyId, eventTeamId: teamId } });
    if (!dummy) {
      throw new NotFoundException('Dummy driver not found');
    }
    return dummy;
  }
}
