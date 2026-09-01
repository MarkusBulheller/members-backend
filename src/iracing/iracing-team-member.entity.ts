import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { IracingTeam } from './iracing-team.entity.js';

/** One roster entry on an IracingTeam — just enough (cust_id + display_name, straight from
 * /team/get's own roster array, no extra /member/get enrichment needed) to answer "is this
 * cust_id on this team" later. Fully re-derived on every sync (see
 * IracingTeamsService.sync() — delete-then-recreate per team), so nothing else should hold a
 * long-lived reference to one of these rows by id. */
@Entity('iracing_team_members')
@Index(['teamId', 'custId'], { unique: true })
export class IracingTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => IracingTeam, (team) => team.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'team_id' })
  team: Relation<IracingTeam>;

  @Column({ name: 'team_id' })
  teamId: number;

  @Column({ name: 'cust_id' })
  custId: number;

  @Column({ name: 'display_name' })
  displayName: string;
}
