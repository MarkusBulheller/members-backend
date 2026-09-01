import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { AchievementTier } from './achievement-tier.entity.js';

/** One driver having earned one tier — created either by AchievementsService.recalculate()
 * (LAPS/WINS/PODIUMS, computed from race results) or by an admin's manual award. The unique
 * index makes recalculate() naturally idempotent: a tier already earned is just skipped. */
@Entity('achievement_awards')
@Index(['driverProfileId', 'tierId'], { unique: true })
export class AchievementAward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DriverProfile, (profile) => profile.awards, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_profile_id' })
  driverProfile: Relation<DriverProfile>;

  @Column({ name: 'driver_profile_id' })
  driverProfileId: string;

  @ManyToOne(() => AchievementTier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tier_id' })
  tier: Relation<AchievementTier>;

  @Column({ name: 'tier_id' })
  tierId: string;

  /** Plain column, not a relation — same cross-module rationale as EventSignup.carId. */
  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'achieved_at', type: 'date' })
  achievedAt: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
