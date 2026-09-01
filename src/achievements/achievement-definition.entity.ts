import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { AchievementIcon } from '../common/enums/achievement-icon.enum.js';
import { AchievementMetric } from '../common/enums/achievement-metric.enum.js';
import { AchievementTier } from './achievement-tier.entity.js';

/** Admin-configured achievement "template" — e.g. "Century Club" (LAPS metric) or "Race Winner"
 * (WINS metric), each broken into tiers (see AchievementTier). A driver's actual earned tiers
 * live in AchievementAward. */
@Entity('achievement_definitions')
export class AchievementDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: AchievementMetric, default: AchievementMetric.MANUAL })
  metric: AchievementMetric;

  @Column({ type: 'enum', enum: AchievementIcon, default: AchievementIcon.TROPHY })
  icon: AchievementIcon;

  /** Only meaningful when metric is TRACK_WIN — which track this achievement is scoped to (e.g.
   * "Won Le Mans 24h"). Plain column, not a relation — same cross-module rationale as
   * EventSignup.carId. Null for every other metric. */
  @Column({ name: 'track_id', type: 'uuid', nullable: true })
  trackId: string | null;

  @OneToMany(() => AchievementTier, (tier) => tier.definition)
  tiers: Relation<AchievementTier>[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
