import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { Track } from '../tracks/track.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';

@Entity('events')
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ManyToOne(() => Track)
  @JoinColumn({ name: 'track_id' })
  track: Relation<Track>;

  @Column({ name: 'track_id' })
  trackId: string;

  /** Multiple classes can share the grid (e.g. a multi-class endurance event running GT3 and
   * LMP2 together) — a plain string array rather than a join table, since there's nothing else
   * to attach per class. Values come from the same CAR_CLASSES list the frontend already uses
   * for Car.carClass, kept as free text here too (not a DB enum) for the same reason that one
   * is. */
  @Column({ name: 'car_classes', type: 'text', array: true })
  carClasses: string[];

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt: Date;

  @Column({ name: 'ends_at', type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ name: 'signup_deadline', type: 'timestamptz', nullable: true })
  signupDeadline: Date | null;

  /** One of a fixed preset list (160/180/360/480/600/720/1440 — see create-event.dto.ts's @IsIn) —
   * stored in minutes rather than hours so non-whole-hour lengths like 2h40m are exact. Drives
   * how the admin frames the timeslot options below (not otherwise validated against
   * startsAt/endsAt, which stay free-form). */
  @Column({ name: 'race_length_minutes', type: 'int' })
  raceLengthMinutes: number;

  /** Candidate start times a driver can flag availability for — see EventTimeslot and
   * EventSignup.timeslots. */
  @OneToMany(() => EventTimeslot, (slot) => slot.event)
  timeslots: Relation<EventTimeslot>[];

  @Column({ type: 'enum', enum: EventStatus, default: EventStatus.DRAFT })
  status: EventStatus;

  /** Links this event to a specific iRacing series-season week (IracingSeriesSeason.seasonId +
   * that season's schedule[].race_week_num) — drives the weather-forecast section on the event
   * detail page. Both null unless explicitly linked; no FK since IracingSeriesSeason rows get
   * replaced wholesale on every catalog sync. */
  @Column({ name: 'iracing_season_id', type: 'int', nullable: true })
  iracingSeasonId: number | null;

  @Column({ name: 'iracing_race_week_num', type: 'int', nullable: true })
  iracingRaceWeekNum: number | null;

  /** Plain column, not a relation — Events doesn't need to depend on the Users module. */
  @Column({ name: 'created_by_user_id' })
  createdByUserId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
