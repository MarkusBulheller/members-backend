import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { RaceResult } from '../race-results/race-result.entity.js';
import { CreateTrackDto } from './dto/create-track.dto.js';
import { UpdateTrackDto } from './dto/update-track.dto.js';
import { TRACKS_UPLOAD_DIR, TRACKS_UPLOAD_URL_PREFIX } from './multer.config.js';
import { Track } from './track.entity.js';

/** A Track as returned by the list/detail endpoints: the entity plus how many imported race
 * results reference it and when the most recent one started (both additive; lastRacedAt is an
 * ISO string, or null when nothing was raced there / start time unknown). */
export type TrackWithStats = Track & { raceCount: number; lastRacedAt: string | null };

@Injectable()
export class TracksService {
  private readonly logger = new Logger(TracksService.name);

  constructor(
    @InjectRepository(Track)
    private readonly tracksRepository: Repository<Track>,
    @InjectRepository(RaceResult)
    private readonly raceResultsRepository: Repository<RaceResult>,
  ) {}

  create(dto: CreateTrackDto): Promise<Track> {
    const track = this.tracksRepository.create({ ...dto, imageUrl: dto.imageUrl || undefined });
    return this.tracksRepository.save(track);
  }

  async findAll(includeInactive: boolean): Promise<TrackWithStats[]> {
    const [tracks, stats] = await Promise.all([
      this.tracksRepository.find({
        where: includeInactive ? {} : { active: true },
        order: { name: 'ASC' },
      }),
      this.raceStatsByTrack(),
    ]);
    return tracks.map((track) => this.withStats(track, stats));
  }

  /** Detail payload: the track with its race count and last-raced date. */
  async findOneDetailed(id: string): Promise<TrackWithStats> {
    const track = await this.findByIdOrThrow(id);
    const stats = await this.raceStatsByTrack(id);
    return this.withStats(track, stats);
  }

  /** race_results per track (count + latest start time), one grouped query; optionally limited
   * to a single track. Tracks without any result are simply absent from the map. */
  async raceStatsByTrack(trackId?: string): Promise<Map<string, { count: number; lastRacedAt: Date | null }>> {
    const query = this.raceResultsRepository
      .createQueryBuilder('r')
      .select('r.trackId', 'trackId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(r.startTime)', 'lastRacedAt')
      .where('r.trackId IS NOT NULL');
    if (trackId) {
      query.andWhere('r.trackId = :trackId', { trackId });
    }
    const rows = await query
      .groupBy('r.trackId')
      .getRawMany<{ trackId: string; count: string; lastRacedAt: Date | string | null }>();
    return new Map(
      rows.map((row) => [
        row.trackId,
        { count: Number(row.count), lastRacedAt: row.lastRacedAt ? new Date(row.lastRacedAt) : null },
      ]),
    );
  }

  private withStats(
    track: Track,
    stats: Map<string, { count: number; lastRacedAt: Date | null }>,
  ): TrackWithStats {
    const entry = stats.get(track.id);
    return Object.assign(track, {
      raceCount: entry?.count ?? 0,
      lastRacedAt: entry?.lastRacedAt ? entry.lastRacedAt.toISOString() : null,
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
    const previousImageUrl = track.imageUrl;
    Object.assign(track, dto, {
      // An empty string is how the portal clears the image (the DTO has no null).
      ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl || null }),
    });
    const saved = await this.tracksRepository.save(track);
    if (dto.imageUrl !== undefined && (dto.imageUrl || null) !== previousImageUrl) {
      await this.deleteUploadedImage(previousImageUrl);
    }
    return saved;
  }

  /** Public URL for a file just stored by the track-image upload endpoint. */
  imageUrlForUpload(file: Express.Multer.File): string {
    return `${TRACKS_UPLOAD_URL_PREFIX}${file.filename}`;
  }

  /** Only files this app stored itself (under /uploads/tracks/) are ever deleted — iRacing CDN
   * URLs and anything else are left alone. */
  private async deleteUploadedImage(imageUrl: string | null): Promise<void> {
    if (!imageUrl || !imageUrl.startsWith(TRACKS_UPLOAD_URL_PREFIX)) return;
    const filename = imageUrl.slice(TRACKS_UPLOAD_URL_PREFIX.length);
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
    try {
      await unlink(join(TRACKS_UPLOAD_DIR, filename));
    } catch (error) {
      this.logger.warn(`Could not delete track image "${filename}": ${(error as Error).message}`);
    }
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
