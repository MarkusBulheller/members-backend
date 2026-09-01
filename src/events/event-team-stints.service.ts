import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toDecimalString } from '../common/decimal.util.js';
import { CreateEventTeamStintDto } from './dto/create-event-team-stint.dto.js';
import { UpdateEventTeamStintDto } from './dto/update-event-team-stint.dto.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeam } from './event-team.entity.js';

@Injectable()
export class EventTeamStintsService {
  constructor(
    @InjectRepository(EventTeamStint)
    private readonly stintsRepository: Repository<EventTeamStint>,
    @InjectRepository(EventTeam)
    private readonly teamsRepository: Repository<EventTeam>,
  ) {}

  async listForTeam(eventId: string, teamId: string): Promise<EventTeamStint[]> {
    await this.findTeamOrThrow(eventId, teamId);
    return this.stintsRepository.find({ where: { eventTeamId: teamId }, order: { order: 'ASC' } });
  }

  async create(eventId: string, teamId: string, dto: CreateEventTeamStintDto): Promise<EventTeamStint> {
    await this.findTeamOrThrow(eventId, teamId);
    const maxOrder = await this.stintsRepository.maximum('order', { eventTeamId: teamId });
    const stint = this.stintsRepository.create({
      driverUserId: dto.driverUserId,
      durationMinutes: toDecimalString(dto.durationMinutes),
      tyreChange: dto.tyreChange ?? true,
      wetOverride: dto.wetOverride ?? null,
      eventTeamId: teamId,
      order: (maxOrder ?? -1) + 1,
    });
    return this.stintsRepository.save(stint);
  }

  /** Only assigns a field when the dto actually carries it — a key present with value
   * `undefined` still gets copied by Object.assign and, per TypeORM's save(), still overwrites
   * the column to NULL, silently clobbering a value the caller never touched (a real bug caught
   * by a round-trip check on EventTeamsService.update(), fixed there the same way). */
  async update(eventId: string, teamId: string, stintId: string, dto: UpdateEventTeamStintDto): Promise<EventTeamStint> {
    const stint = await this.findStintOrThrow(eventId, teamId, stintId);
    if (dto.driverUserId !== undefined) stint.driverUserId = dto.driverUserId;
    if (dto.durationMinutes !== undefined) stint.durationMinutes = toDecimalString(dto.durationMinutes) ?? null;
    if (dto.tyreChange !== undefined) stint.tyreChange = dto.tyreChange;
    if (dto.wetOverride !== undefined) stint.wetOverride = dto.wetOverride;
    return this.stintsRepository.save(stint);
  }

  /** Toggles actualStartAt between "now" (server time) and null — a stint that's running short
   * or long re-anchors every later stint's derived schedule to this real moment. Clicking again
   * clears it (undo a mis-click, or hand the "current" marker to a different stint). */
  async toggleStartNow(eventId: string, teamId: string, stintId: string): Promise<EventTeamStint> {
    const stint = await this.findStintOrThrow(eventId, teamId, stintId);
    stint.actualStartAt = stint.actualStartAt ? null : new Date();
    return this.stintsRepository.save(stint);
  }

  async remove(eventId: string, teamId: string, stintId: string): Promise<void> {
    const stint = await this.findStintOrThrow(eventId, teamId, stintId);
    await this.stintsRepository.remove(stint);
  }

  /** Swaps `order` with the adjacent stint — a no-op (not an error) at either end of the list,
   * since "move up" on the first stint / "move down" on the last has nothing to do. */
  async move(eventId: string, teamId: string, stintId: string, direction: 'up' | 'down'): Promise<EventTeamStint[]> {
    const stints = await this.listForTeam(eventId, teamId);
    const index = stints.findIndex((s) => s.id === stintId);
    if (index === -1) {
      throw new NotFoundException('Stint not found');
    }
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex >= 0 && swapIndex < stints.length) {
      const a = stints[index];
      const b = stints[swapIndex];
      [a.order, b.order] = [b.order, a.order];
      await this.stintsRepository.save([a, b]);
    }
    return this.listForTeam(eventId, teamId);
  }

  private async findTeamOrThrow(eventId: string, teamId: string): Promise<EventTeam> {
    const team = await this.teamsRepository.findOne({ where: { id: teamId, eventId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    return team;
  }

  private async findStintOrThrow(eventId: string, teamId: string, stintId: string): Promise<EventTeamStint> {
    await this.findTeamOrThrow(eventId, teamId);
    const stint = await this.stintsRepository.findOne({ where: { id: stintId, eventTeamId: teamId } });
    if (!stint) {
      throw new NotFoundException('Stint not found');
    }
    return stint;
  }
}
