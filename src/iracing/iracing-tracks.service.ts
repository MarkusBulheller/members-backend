import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IracingTrackData, IracingService } from './iracing.service.js';
import { IracingTrack } from './iracing-track.entity.js';

export interface IracingTrackWithImages extends IracingTrack {
  smallImageUrl: string | null;
  logoUrl: string | null;
}

@Injectable()
export class IracingTracksService {
  constructor(
    @InjectRepository(IracingTrack)
    private readonly tracksRepository: Repository<IracingTrack>,
    private readonly iracingService: IracingService,
    private readonly configService: ConfigService,
  ) {}

  async list(includeRetired: boolean): Promise<IracingTrackWithImages[]> {
    const tracks = await this.tracksRepository.find({
      where: includeRetired ? {} : { retired: false },
      order: { trackName: 'ASC' },
    });
    return tracks.map((track) => this.withResolvedImages(track));
  }

  /** Exact lookup by iRacing's own track_id — used by RaceResultsService to give an auto-created
   * team Track real category/location/image data instead of a blank placeholder. */
  async findByIdWithImages(trackId: number): Promise<IracingTrackWithImages | null> {
    const track = await this.tracksRepository.findOne({ where: { trackId } });
    return track ? this.withResolvedImages(track) : null;
  }

  async sync(code: string, codeVerifier: string): Promise<{ synced: number }> {
    const tracks = await this.iracingService.exchangeCodeForTrackCatalog(code, codeVerifier);
    const rows = tracks.map((track) => this.toEntity(track));
    if (rows.length > 0) {
      await this.tracksRepository.upsert(rows, ['trackId']);
    }
    return { synced: rows.length };
  }

  /** Same folder + filename + CDN base pattern as IracingCarsService.withResolvedImages(). */
  private withResolvedImages(track: IracingTrack): IracingTrackWithImages {
    const base = this.configService.get<string>('IRACING_IMAGE_BASE_URL', 'https://images-static.iracing.com');
    const resolve = (filename: string | null) => {
      if (!filename || !track.folder) return null;
      return `${base}/${track.folder.replace(/^\/+|\/+$/g, '')}/${filename.replace(/^\/+/, '')}`;
    };

    return {
      ...track,
      smallImageUrl: resolve(track.smallImage),
      logoUrl: resolve(track.logo),
    };
  }

  private toEntity(track: IracingTrackData): Partial<IracingTrack> {
    return {
      trackId: track.track_id,
      trackName: track.track_name,
      configName: track.config_name,
      category: track.category,
      location: track.location,
      retired: track.retired,
      smallImage: track.small_image,
      logo: track.logo,
      folder: track.folder,
    };
  }
}
