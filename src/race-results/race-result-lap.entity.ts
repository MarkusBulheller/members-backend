import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResult } from './race-result.entity.js';

/** One lap, for one driver, within a team's race result — from iRacing's /results/lap_data.
 * `sessionTime` is iRacing's own running session clock, kept as an opaque sort key (its scale
 * is unconfirmed) rather than a real duration — the frontend orders all of a team's laps by it
 * and splits into stints wherever the driver changes (see lib/stints.ts), since `lap_events`
 * turned out not to reliably flag pit stops. Stint number itself isn't persisted here, so the
 * boundary rule can be adjusted without a migration. */
@Entity('race_result_laps')
export class RaceResultLap {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RaceResult, (result) => result.laps, { onDelete: 'CASCADE' })
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

  @Column({ name: 'lap_number', type: 'int' })
  lapNumber: number;

  @Column({ name: 'lap_time_ms', type: 'int', nullable: true })
  lapTimeMs: number | null;

  @Column({ default: false })
  incident: boolean;

  @Column({ name: 'session_time', type: 'int' })
  sessionTime: number;
}
