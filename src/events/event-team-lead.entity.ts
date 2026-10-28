import { CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { User } from '../users/user.entity.js';
import { EventTeam } from './event-team.entity.js';

/** A member who leads ONE event crew (EventTeam) — a team lead can run the race planning of that
 * crew in that event only (see TeamManagePolicy) without being an admin. The lead must also be
 * placed on the crew (a non-cancelled EventSignup with that eventTeamId); the policy checks that
 * on every request, and EventsService drops the row when the driver leaves the crew. Rows go away
 * with the crew or the user. */
@Entity('event_team_leads')
@Index('idx_event_team_leads_user_id', ['userId'])
export class EventTeamLead {
  @PrimaryColumn({ name: 'event_team_id', type: 'uuid' })
  eventTeamId: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => EventTeam, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_team_id' })
  eventTeam: Relation<EventTeam>;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
