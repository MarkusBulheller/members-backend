import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** One entry in the public marketing site's "Team Highlights" timeline (founding, first podium,
 * championships, etc.) — admin-managed here, read by the anonymous public site through
 * PublicTeamHighlightsController so the timeline reflects real team history instead of being
 * hardcoded in that project's own source. */
@Entity('team_highlights')
export class TeamHighlight {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Free text, e.g. "Season 3 · 2026" — not a real date, since a season doesn't map to one. */
  @Column()
  period: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  /** Display order on the timeline — admin-reorderable (see move()), not derived from `period`
   * since that's free text and can't be sorted reliably. */
  @Column({ name: 'sort_order', type: 'int' })
  order: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
