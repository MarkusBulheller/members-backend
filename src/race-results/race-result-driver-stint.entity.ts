import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResult } from './race-result.entity.js';

/** One driver's stint within a team's race result — from iRacing's per-result driver_results
 * array, which is how team races report individual driver stats even though the team as a
 * whole has one starting/finishing position and one car. `driverProfile` is null when the
 * cust_id doesn't match anyone on our roster (e.g. a guest/loaned driver never added here). */
@Entity('race_result_driver_stints')
export class RaceResultDriverStint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RaceResult, (result) => result.driverStints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'race_result_id' })
  raceResult: Relation<RaceResult>;

  @Column({ name: 'race_result_id' })
  raceResultId: string;

  @ManyToOne(() => DriverProfile, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'driver_profile_id' })
  driverProfile: Relation<DriverProfile> | null;

  @Column({ name: 'driver_profile_id', type: 'uuid', nullable: true })
  driverProfileId: string | null;

  @Column({ name: 'iracing_cust_id', type: 'int' })
  iracingCustId: number;

  @Column({ name: 'display_name' })
  displayName: string;

  @Column({ name: 'starting_position', type: 'int', nullable: true })
  startingPosition: number | null;

  @Column({ name: 'finishing_position', type: 'int', nullable: true })
  finishingPosition: number | null;

  @Column({ name: 'average_lap_time_ms', type: 'int', nullable: true })
  averageLapTimeMs: number | null;

  @Column({ name: 'best_lap_time_ms', type: 'int', nullable: true })
  bestLapTimeMs: number | null;

  @Column({ type: 'int', nullable: true })
  incidents: number | null;

  @Column({ name: 'laps_complete', type: 'int', nullable: true })
  lapsComplete: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
