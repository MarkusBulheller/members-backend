import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Car } from '../cars/car.entity.js';
import { Track } from '../tracks/track.entity.js';
import { RaceResultDriverStint } from './race-result-driver-stint.entity.js';
import { RaceResultLap } from './race-result-lap.entity.js';

/** One imported iRacing race result for one of our team's car entries — see
 * RaceResultsService.importFromIracing(). subsessionId + teamId together identify a unique
 * result (the same subsession can have many teams; re-importing the same team+session is a
 * no-op guard, not a duplicate). */
@Entity('race_results')
@Unique(['subsessionId', 'teamId'])
export class RaceResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subsession_id', type: 'int' })
  subsessionId: number;

  @Column({ name: 'team_id', type: 'int' })
  teamId: number;

  @Column({ name: 'series_name', type: 'varchar', nullable: true })
  seriesName: string | null;

  @Column({ name: 'track_name' })
  trackName: string;

  @Column({ name: 'track_config', type: 'varchar', nullable: true })
  trackConfig: string | null;

  @Column({ name: 'car_name', type: 'varchar', nullable: true })
  carName: string | null;

  /** Best-effort links to our roster's Car/Track, resolved (and auto-created if missing) by
   * name during import — see CarsService.ensureExists()/TracksService.ensureExists(). Null car
   * only happens if iRacing's result had no car name at all. */
  @ManyToOne(() => Car, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'car_id' })
  car: Relation<Car> | null;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId: string | null;

  @ManyToOne(() => Track, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'track_id' })
  track: Relation<Track> | null;

  @Column({ name: 'track_id', type: 'uuid', nullable: true })
  trackId: string | null;

  @Column({ name: 'start_time', type: 'timestamptz', nullable: true })
  startTime: Date | null;

  @Column({ name: 'end_time', type: 'timestamptz', nullable: true })
  endTime: Date | null;

  @Column({ name: 'starting_position', type: 'int', nullable: true })
  startingPosition: number | null;

  @Column({ name: 'finishing_position', type: 'int', nullable: true })
  finishingPosition: number | null;

  /** Position within the team's own car class (e.g. GT3), not overall field position — null for
   * results imported before this field was captured. */
  @Column({ name: 'starting_position_in_class', type: 'int', nullable: true })
  startingPositionInClass: number | null;

  @Column({ name: 'finishing_position_in_class', type: 'int', nullable: true })
  finishingPositionInClass: number | null;

  @Column({ name: 'team_laps_complete', type: 'int', nullable: true })
  teamLapsComplete: number | null;

  @Column({ name: 'total_laps', type: 'int', nullable: true })
  totalLaps: number | null;

  @Column({ name: 'team_incidents', type: 'int', nullable: true })
  teamIncidents: number | null;

  /** From iRacing's session_splits — this subsession's 1-indexed position among the sibling
   * subsessions the event was split into (null if the event wasn't split at all). */
  @Column({ name: 'split_number', type: 'int', nullable: true })
  splitNumber: number | null;

  @Column({ name: 'total_splits', type: 'int', nullable: true })
  totalSplits: number | null;

  /** Opt-in public share link token — null means this result isn't shared. Set by an admin via
   * RaceResultsService.generateShareLink() (e.g. to post a result in Discord without requiring
   * the recipient to log in); a distinct random token rather than the row's own id so a shared
   * link can be revoked independently of the result's normal (login-gated) URL. */
  @Column({ name: 'share_token', type: 'varchar', nullable: true, unique: true })
  shareToken: string | null;

  @OneToMany(() => RaceResultDriverStint, (stint) => stint.raceResult)
  driverStints: Relation<RaceResultDriverStint>[];

  @OneToMany(() => RaceResultLap, (lap) => lap.raceResult)
  laps: Relation<RaceResultLap>[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
