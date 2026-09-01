import { Column, Entity, PrimaryColumn } from 'typeorm';

/** One row per active official season (a series' current run) — mirrors IracingCar/IracingTrack
 * as a read-through cache of iRacing's own catalog, refreshed via the "Sync" button on the
 * Series page. `schedule` is the full raw per-race-week array (track + weather) exactly as
 * returned by /series/season_schedule — see IracingService.exchangeCodeForSeriesCatalog(). */
@Entity('iracing_series_seasons')
export class IracingSeriesSeason {
  @PrimaryColumn({ name: 'season_id', type: 'int' })
  seasonId: number;

  @Column({ name: 'series_id', type: 'int' })
  seriesId: number;

  @Column({ name: 'series_name' })
  seriesName: string;

  @Column({ name: 'season_name' })
  seasonName: string;

  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @Column({ name: 'license_group', type: 'int', nullable: true })
  licenseGroup: number | null;

  @Column({ default: true })
  official: boolean;

  @Column({ default: true })
  active: boolean;

  @Column({ type: 'jsonb' })
  schedule: unknown[];

  /** Raw path from /series/assets, relative to IRACING_IMAGE_BASE_URL — resolved to a full URL
   * at read time, see IracingSeriesService.withResolvedLogo(). */
  @Column({ type: 'varchar', nullable: true })
  logo: string | null;

  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;

  /** Admin opt-in — IracingCarUsageSyncService's hourly scan only processes series flagged here,
   * not the whole catalog (most series aren't worth tracking for this). */
  @Column({ name: 'track_car_usage', default: false })
  trackCarUsage: boolean;
}
