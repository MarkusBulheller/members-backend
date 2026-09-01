import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateTeamHighlightDto } from './dto/create-team-highlight.dto.js';
import { UpdateTeamHighlightDto } from './dto/update-team-highlight.dto.js';
import { TeamHighlight } from './team-highlight.entity.js';

@Injectable()
export class TeamHighlightsService {
  constructor(
    @InjectRepository(TeamHighlight)
    private readonly highlightsRepository: Repository<TeamHighlight>,
  ) {}

  list(): Promise<TeamHighlight[]> {
    return this.highlightsRepository.find({ order: { order: 'ASC' } });
  }

  async create(dto: CreateTeamHighlightDto): Promise<TeamHighlight> {
    const maxOrder = await this.highlightsRepository.maximum('order');
    const highlight = this.highlightsRepository.create({
      period: dto.period,
      title: dto.title,
      description: dto.description,
      order: (maxOrder ?? -1) + 1,
    });
    return this.highlightsRepository.save(highlight);
  }

  async update(id: string, dto: UpdateTeamHighlightDto): Promise<TeamHighlight> {
    const highlight = await this.findOrThrow(id);
    if (dto.period !== undefined) highlight.period = dto.period;
    if (dto.title !== undefined) highlight.title = dto.title;
    if (dto.description !== undefined) highlight.description = dto.description;
    return this.highlightsRepository.save(highlight);
  }

  async remove(id: string): Promise<void> {
    const highlight = await this.findOrThrow(id);
    await this.highlightsRepository.remove(highlight);
  }

  /** Swaps `order` with the adjacent highlight — a no-op (not an error) at either end of the
   * timeline, same convention as EventTeamStintsService.move(). */
  async move(id: string, direction: 'up' | 'down'): Promise<TeamHighlight[]> {
    const highlights = await this.list();
    const index = highlights.findIndex((h) => h.id === id);
    if (index === -1) {
      throw new NotFoundException('Highlight not found');
    }
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex >= 0 && swapIndex < highlights.length) {
      const a = highlights[index];
      const b = highlights[swapIndex];
      [a.order, b.order] = [b.order, a.order];
      await this.highlightsRepository.save([a, b]);
    }
    return this.list();
  }

  private async findOrThrow(id: string): Promise<TeamHighlight> {
    const highlight = await this.highlightsRepository.findOne({ where: { id } });
    if (!highlight) {
      throw new NotFoundException('Highlight not found');
    }
    return highlight;
  }
}
