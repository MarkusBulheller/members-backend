import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { AchievementDefinition } from './achievement-definition.entity.js';

/** One rung of an AchievementDefinition — e.g. "100 Laps" (threshold 100) under a LAPS-metric
 * definition, or a free-standing label with no threshold under a MANUAL one. */
@Entity('achievement_tiers')
export class AchievementTier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AchievementDefinition, (definition) => definition.tiers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'definition_id' })
  definition: Relation<AchievementDefinition>;

  @Column({ name: 'definition_id' })
  definitionId: string;

  @Column()
  label: string;

  /** The metric count needed to earn this tier — required for LAPS/WINS/PODIUMS definitions,
   * null for MANUAL ones (enforced in AchievementsService, not here, since it depends on the
   * parent definition's metric). */
  @Column({ type: 'int', nullable: true })
  threshold: number | null;

  /** Explicit ordering since `threshold` can be null (MANUAL tiers) — ties/gaps are fine. */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
