import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { EventTeam } from './event-team.entity.js';

/** A named driver that exists only inside one team's stint plan, with no portal signup behind it —
 * either a free-text placeholder (a "TBD", a what-if) or, when `driverProfileId` is set, a guest
 * pulled from the Drivers roster who has no portal account (and so can't have an EventSignup). Its own `id` is
 * used as the driver id everywhere a real driver's userId would be (EventTeamStint.driverUserId,
 * EventTeamDriverSettings.userId), which both already store a plain string with no FK, so the plan
 * needs no special-casing at the storage level. */
@Entity('event_team_dummy_drivers')
export class EventTeamDummyDriver {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EventTeam, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_team_id' })
  eventTeam: Relation<EventTeam>;

  @Column({ name: 'event_team_id' })
  eventTeamId: string;

  @Column()
  name: string;

  /** The roster entry (DriverProfile.id) this was added from; null for a free-text placeholder.
   * Plain column, not a relation — Events stays decoupled from the Drivers module. `name` is a
   * snapshot taken at add time; the frontend shows the roster's current name when it can. */
  @Column({ name: 'driver_profile_id', type: 'uuid', nullable: true })
  driverProfileId: string | null;

  /** Same meaning as EventSignup.availableHours, except an empty list means "no restriction" —
   * a placeholder with no hours set is treated as free for any stint, which is what planning
   * around an unknown driver wants (see the plan page's availability check). */
  @Column({ name: 'available_hours', type: 'timestamptz', array: true, default: () => "'{}'" })
  availableHours: Date[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
