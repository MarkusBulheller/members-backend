import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { CarTrackSetup } from '../car-track-setups/car-track-setup.entity.js';
import { Livery } from '../liveries/livery.entity.js';

@Entity('cars')
export class Car {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'car_class' })
  carClass: string;

  @Column({ name: 'tank_capacity_liters', type: 'decimal', precision: 5, scale: 2 })
  tankCapacityLiters: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** The iRacing stock car image, captured when this car was created via the "Pick from
   * iRacing" picker (see CarFormPage) — a full CDN URL, not a locally-uploaded asset like
   * Livery.imageUrl. Null for cars added without picking an iRacing match. */
  @Column({ name: 'image_url', type: 'varchar', nullable: true })
  imageUrl: string | null;

  /** Soft-delete flag — retired cars stay in the database (event signups and achievements may
   * still reference their id) but drop out of the default active-cars listing. */
  @Column({ default: true })
  active: boolean;

  @OneToMany(() => Livery, (livery) => livery.car)
  liveries: Relation<Livery>[];

  @OneToMany(() => CarTrackSetup, (setup) => setup.car)
  trackSetups: Relation<CarTrackSetup>[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
