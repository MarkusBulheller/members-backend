import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Running tally of how many race entries used each car, for one race week of one tracked series
 * — built up by IracingCarUsageSyncService's hourly scan, not synced wholesale like
 * IracingSeriesSeason. entryCount counts *entries* (one per team/driver in a session's results),
 * not sessions — a car run by five different teams in one race counts five times. */
@Entity('iracing_car_usage_stats')
@Index(['seasonId', 'raceWeekNum', 'carId'], { unique: true })
export class IracingCarUsageStat {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'season_id', type: 'int' })
  seasonId: number;

  @Column({ name: 'race_week_num', type: 'int' })
  raceWeekNum: number;

  @Column({ name: 'car_id', type: 'int' })
  carId: number;

  @Column({ name: 'car_name', type: 'varchar' })
  carName: string;

  /** e.g. "GT3" — from the same per-entry car_class_name each result already carries (see
   * IracingService.fetchCarUsageForSubsession), not iRacing's global car catalog category. Lets
   * the tierlist split by class for a mixed-class series instead of one flat list. */
  @Column({ name: 'car_class', type: 'varchar', default: 'Unknown' })
  carClass: string;

  @Column({ name: 'entry_count', type: 'int', default: 0 })
  entryCount: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
