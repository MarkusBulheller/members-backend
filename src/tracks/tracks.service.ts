import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateTrackDto } from './dto/create-track.dto.js';
import { UpdateTrackDto } from './dto/update-track.dto.js';
import { Track } from './track.entity.js';

@Injectable()
export class TracksService {
  constructor(
    @InjectRepository(Track)
    private readonly tracksRepository: Repository<Track>,
  ) {}

  create(dto: CreateTrackDto): Promise<Track> {
    const track = this.tracksRepository.create(dto);
    return this.tracksRepository.save(track);
  }

  findAll(includeInactive: boolean): Promise<Track[]> {
    return this.tracksRepository.find({
      where: includeInactive ? {} : { active: true },
      order: { name: 'ASC' },
    });
  }

  async findByIdOrThrow(id: string): Promise<Track> {
    const track = await this.tracksRepository.findOne({ where: { id } });
    if (!track) {
      throw new NotFoundException('Track not found');
    }
    return track;
  }

  async update(id: string, dto: UpdateTrackDto): Promise<Track> {
    const track = await this.findByIdOrThrow(id);
    Object.assign(track, dto);
    return this.tracksRepository.save(track);
  }

  /** Soft delete — see the `active` column comment on the Track entity. */
  async deactivate(id: string): Promise<void> {
    const track = await this.findByIdOrThrow(id);
    track.active = false;
    await this.tracksRepository.save(track);
  }

  /** Idempotent-by-name lookup used by race-result import — mirrors CarsService.ensureExists().
   * `name` should already be composed as "{trackName} - {config}" (see RaceResultsService),
   * matching the convention TrackFormPage's "Pick from iRacing" flow uses. `category`/`location`/
   * `imageUrl` come from the local iRacing track catalog when RaceResultsService can resolve one
   * (see IracingTracksService.findByIdWithImages()) — real data, not a guess; only falls back to
   * an obvious placeholder when that catalog lookup came up empty (e.g. not synced yet). */
  async ensureExists(
    name: string,
    options?: { category?: string | null; location?: string | null; imageUrl?: string | null },
  ): Promise<Track> {
    const existing = await this.tracksRepository
      .createQueryBuilder('track')
      .where('LOWER(track.name) = LOWER(:name)', { name })
      .getOne();
    if (existing) return existing;

    const track = this.tracksRepository.create({
      name,
      category: options?.category ?? 'Unknown',
      location: options?.location ?? null,
      imageUrl: options?.imageUrl ?? null,
      notes: options?.category
        ? null
        : 'Auto-added from an imported race result — the local iRacing track catalog has no ' +
          'match for it (try syncing from iRacing), so category is a placeholder. Please review.',
    });
    return this.tracksRepository.save(track);
  }
}
