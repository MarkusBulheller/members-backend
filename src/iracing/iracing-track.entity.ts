import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** A local cache of iRacing's track catalog (from the Data API's /track/get), refreshed by an
 * admin via the "Sync from iRacing" action — see IracingTracksService. Mirrors IracingCar;
 * public reference data, safe to cache indefinitely between syncs. */
@Entity('iracing_tracks')
export class IracingTrack {
  /** iRacing's own track_id — unique per layout/config (e.g. "Watkins Glen Boot" and
   * "Watkins Glen Cup" are different track_ids), so it's a safe PK on its own. */
  @PrimaryColumn({ name: 'track_id' })
  trackId: number;

  @Column({ name: 'track_name' })
  trackName: string;

  /** e.g. "Boot", "Cup" — null for tracks with only one layout. */
  @Column({ name: 'config_name', type: 'varchar', nullable: true })
  configName: string | null;

  /** "road" | "oval" | "dirt_road" | "dirt_oval" */
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @Column({ type: 'varchar', nullable: true })
  location: string | null;

  @Column({ default: false })
  retired: boolean;

  /** Raw filename from /track/assets — see IracingTracksService.withResolvedImages() for how
   * this, `folder`, and the CDN base combine into a real URL. */
  @Column({ name: 'small_image', type: 'varchar', nullable: true })
  smallImage: string | null;

  @Column({ type: 'varchar', nullable: true })
  logo: string | null;

  @Column({ type: 'varchar', nullable: true })
  folder: string | null;

  @UpdateDateColumn({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}
