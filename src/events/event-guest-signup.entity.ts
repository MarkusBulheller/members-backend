import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { Event } from './event.entity.js';

export type GuestSignupStatus = 'CONFIRMED' | 'CANCELLED';

/** A signup for a GUEST driver — a manually added DriverProfile with `userId = null`, i.e. someone
 * with no portal account (so no EventSignup, whose userId is mandatory). They sign up through
 * Discord (matched through DriverProfile.discordUsername, then bound to the Discord id); an admin can also remove them or place them on a
 * team (as an EventTeamDummyDriver). Deliberately a separate table from member signups. */
@Entity('event_guest_signups')
@Index('uq_event_guest_signups_event_profile', ['eventId', 'driverProfileId'], { unique: true })
export class EventGuestSignup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Relation<Event>;

  /** Indexed through the leading column of the unique (event_id, driver_profile_id) index. */
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @ManyToOne(() => DriverProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_profile_id' })
  driverProfile: Relation<DriverProfile>;

  @Index('idx_event_guest_signups_driver_profile_id')
  @Column({ name: 'driver_profile_id', type: 'uuid' })
  driverProfileId: string;

  /** Same free-standing-text rationale as EventSignup.carClass. */
  @Column({ name: 'car_class', type: 'varchar', nullable: true })
  carClass: string | null;

  /** The chosen candidate start times (EventTimeslot ids) — a plain array, not a join table. */
  @Column({ name: 'timeslot_ids', type: 'uuid', array: true, default: () => "'{}'" })
  timeslotIds: string[];

  /** Ranking over `timeslotIds`, most preferred first — same semantics as
   * EventSignup.timeslotPreference (null = never ranked, treat as chronological). */
  @Column({ name: 'timeslot_preference', type: 'uuid', array: true, nullable: true })
  timeslotPreference: string[] | null;

  @Column({ type: 'varchar', length: 20, default: 'CONFIRMED' })
  status: GuestSignupStatus;

  @CreateDateColumn({ name: 'signed_up_at', type: 'timestamptz' })
  signedUpAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
