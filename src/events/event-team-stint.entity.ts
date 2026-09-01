import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { EventTeam } from './event-team.entity.js';

/** One planned driving stint in a team's race strategy — an ordered list building up the full
 * race (see EventTeamStintsService.move() for how `order` gets reshuffled). The absolute start
 * time of each stint isn't stored by default: the planning page derives it from the event's start
 * time plus every prior stint's duration and the team's pit-time settings, so reordering or
 * resizing a stint never leaves stale timestamps behind. `actualStartAt` (see below) is the one
 * exception — a real recorded moment that re-anchors every later stint's derived time to reality
 * once the race stops following the plan exactly. */
@Entity('event_team_stints')
export class EventTeamStint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EventTeam, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_team_id' })
  eventTeam: Relation<EventTeam>;

  @Column({ name: 'event_team_id' })
  eventTeamId: string;

  @Column({ name: 'stint_order', type: 'int' })
  order: number;

  /** Plain column, not a relation to User — same decoupling rationale as EventSignup.userId. */
  @Column({ name: 'driver_user_id', type: 'varchar', nullable: true })
  driverUserId: string | null;

  @Column({ name: 'duration_minutes', type: 'decimal', precision: 6, scale: 2, nullable: true })
  durationMinutes: string | null;

  /** Whether tyres get changed during the pit stop immediately before this stint — ignored for
   * the first stint (there's no pit stop before the race even starts). Lets the planning page
   * skip the team's tyreChangeDurationSeconds for a "splash and go" stint instead of always
   * assuming a full tyre change at every stop. */
  @Column({ name: 'tyre_change', type: 'boolean', default: true })
  tyreChange: boolean;

  /** Set via the "Start Now" button (server-generated timestamp, not client-supplied — avoids a
   * driver's own clock skew) when this stint actually starts. Null until then; toggled back to
   * null by clicking again. Every later stint's derived start time re-anchors from here instead
   * of continuing the theoretical plan, once set. */
  @Column({ name: 'actual_start_at', type: 'timestamptz', nullable: true })
  actualStartAt: Date | null;

  /** Manual override for whether this stint runs in wet conditions — null (the default) leaves it
   * to the auto-detect from the event's weather forecast (see EventTeamPlanPage's isWetStint);
   * true/false forces wet/dry regardless of forecast, for events with no linked forecast or when
   * the admin knows better than the model. Feeds the same dry/wet lap-time pick either way. */
  @Column({ name: 'wet_override', type: 'boolean', nullable: true })
  wetOverride: boolean | null;
}
