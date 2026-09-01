import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Car } from '../cars/car.entity.js';
import { Track } from '../tracks/track.entity.js';

/** Per-car, per-track setup notes — fuel consumption and pit lane timing vary by track, so
 * these live on the (car, track) pair rather than on Car or Track directly. */
@Entity('car_track_setups')
@Unique(['carId', 'trackId'])
export class CarTrackSetup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Car, (car) => car.trackSetups, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car: Relation<Car>;

  @Column({ name: 'car_id' })
  carId: string;

  @ManyToOne(() => Track, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'track_id' })
  track: Relation<Track>;

  @Column({ name: 'track_id' })
  trackId: string;

  @Column({ name: 'fuel_per_lap_liters', type: 'decimal', precision: 5, scale: 3, nullable: true })
  fuelPerLapLiters: string | null;

  /** Time lost taking a drive-through in the pits at this track, in seconds. */
  @Column({ name: 'pit_lane_time_seconds', type: 'decimal', precision: 6, scale: 2, nullable: true })
  pitLaneTimeSeconds: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
