import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { EventTeam } from './event-team.entity.js';

/** One driver's personal pace/fuel figures for a specific team — overrides EventTeam's own
 * team-wide baseline (see the comment there) once a stint is actually assigned to this driver.
 * Lazily created: there's no row until an admin sets a value for that driver, and every field
 * stays optional so a driver can have only e.g. a fuel number without a lap time. */
@Entity('event_team_driver_settings')
@Index(['eventTeamId', 'userId'], { unique: true })
export class EventTeamDriverSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EventTeam, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_team_id' })
  eventTeam: Relation<EventTeam>;

  @Column({ name: 'event_team_id' })
  eventTeamId: string;

  /** Plain column, not a relation to User — same decoupling rationale as EventSignup.userId. */
  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'lap_time_dry_seconds', type: 'decimal', precision: 6, scale: 3, nullable: true })
  lapTimeDrySeconds: string | null;

  @Column({ name: 'lap_time_wet_seconds', type: 'decimal', precision: 6, scale: 3, nullable: true })
  lapTimeWetSeconds: string | null;

  @Column({ name: 'fuel_usage_per_lap_liters', type: 'decimal', precision: 5, scale: 3, nullable: true })
  fuelUsagePerLapLiters: string | null;
}
