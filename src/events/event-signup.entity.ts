import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { EventTeam } from './event-team.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { Event } from './event.entity.js';

@Entity('event_signups')
@Index(['eventId', 'userId'], { unique: true })
export class EventSignup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Relation<Event>;

  @Column({ name: 'event_id' })
  eventId: string;

  /** Plain column, not a relation to User — keeps Events decoupled from the Users module. */
  @Column({ name: 'user_id' })
  userId: string;

  /** Plain column, not a relation to Car — keeps Events decoupled from the Cars module. */
  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId: string | null;

  /** Which of the event's carClasses this driver intends to run — free-standing text, not a
   * relation, so it stays valid even if the event's carClasses list is edited afterward. */
  @Column({ name: 'car_class', type: 'text', nullable: true })
  carClass: string | null;

  /** Optional fallback class if the primary one doesn't pan out (e.g. not enough entries) —
   * same free-standing-text rationale as carClass. */
  @Column({ name: 'secondary_car_class', type: 'text', nullable: true })
  secondaryCarClass: string | null;

  @Column({ type: 'enum', enum: SignupStatus, default: SignupStatus.CONFIRMED })
  status: SignupStatus;

  /** Which of the event's candidate start times this driver says they can do — see
   * EventTimeslot. Not capacity-limited, just an availability signal; a signup can cover more
   * than one option. */
  @ManyToMany(() => EventTimeslot)
  @JoinTable({
    name: 'event_signup_timeslots',
    joinColumn: { name: 'signup_id' },
    inverseJoinColumn: { name: 'timeslot_id' },
  })
  timeslots: Relation<EventTimeslot>[];

  /** Actual wall-clock hours (each the on-the-hour start of a stint, e.g. 18:00) this driver
   * can take a driving stint during the race — distinct from `timeslots`, which are candidate
   * overall start times. Stored as absolute timestamps (not offsets from a start time) so the
   * same real-world hour lines up across every timeslot's availability grid, since each
   * timeslot implies a different race window. */
  @Column({ name: 'available_hours', type: 'timestamptz', array: true, default: () => "'{}'" })
  availableHours: Date[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** Which car/crew (see EventTeam) this driver has been placed on by an admin — null until
   * assigned. A real relation (not a plain column, unlike carId/userId above) so deleting a team
   * automatically clears this back to null rather than leaving a dangling reference. */
  @ManyToOne(() => EventTeam, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'event_team_id' })
  eventTeam: Relation<EventTeam> | null;

  @Column({ name: 'event_team_id', type: 'uuid', nullable: true })
  eventTeamId: string | null;

  @CreateDateColumn({ name: 'signed_up_at', type: 'timestamptz' })
  signedUpAt: Date;
}
