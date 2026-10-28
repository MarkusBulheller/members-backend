import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type AutoImportMode = 'NOTIFY' | 'AUTO';
export type AutoImportRunStatus = 'OK' | 'SKIPPED' | 'ERROR';

/** Singleton row (always id 1, see AUTO_IMPORT_SETTINGS_ID) holding the on/off switch and mode of
 * the automatic race-result import — see IracingResultAutoImportService. Which teams are watched
 * is a per-team flag (IracingTeam.autoImport), not stored here. */
@Entity('iracing_auto_import_settings')
export class IracingAutoImportSettings {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** 'NOTIFY' = announce new results and let an admin click Import; 'AUTO' = import by itself. */
  @Column({ type: 'varchar', default: 'NOTIFY' })
  mode: AutoImportMode;

  /** Only sessions that ended at least this many minutes ago are considered (iRacing needs a while
   * to publish complete results). */
  @Column({ name: 'delay_minutes', type: 'int', default: 20 })
  delayMinutes: number;

  /** Set to now() whenever `enabled` goes false -> true: only results that finished after this
   * moment are picked up (no backfill of history). */
  @Column({ name: 'enabled_since', type: 'timestamptz', nullable: true })
  enabledSince: Date | null;

  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ name: 'last_run_status', type: 'varchar', nullable: true })
  lastRunStatus: AutoImportRunStatus | null;

  @Column({ name: 'last_run_message', type: 'text', nullable: true })
  lastRunMessage: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
