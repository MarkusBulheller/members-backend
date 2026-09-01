import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Event } from './event.entity.js';

/** One candidate start time for an event — endurance events commonly offer a few options (e.g.
 * a 24h race starting at 14:00, 20:00, or 02:00 UTC) so drivers in different time zones can each
 * flag which ones they can actually be online for. See EventSignup.timeslots for the
 * many-to-many side (a signup can cover more than one slot — a driver might be able to do
 * either the 14:00 or the 20:00 start). No capacity per slot — this is a plain availability
 * signal, not a limited resource. */
@Entity('event_timeslots')
export class EventTimeslot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Event, (event) => event.timeslots, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Relation<Event>;

  @Column({ name: 'event_id' })
  eventId: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt: Date;
}
