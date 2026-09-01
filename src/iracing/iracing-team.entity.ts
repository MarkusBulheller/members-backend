import { Entity, PrimaryColumn, Column, OneToMany, UpdateDateColumn, type Relation } from 'typeorm';
import { IracingTeamMember } from './iracing-team-member.entity.js';

/** Cached iRacing Team, imported (possibly several at once — see IracingTeamsService.sync()) via
 * an admin's own OAuth login: /team/membership reveals every team *that account* belongs to, so
 * whoever runs "Sync from iRacing" needs to actually be a member of whichever team(s) they want
 * imported. Roster membership itself is *not* cross-referenced against this app's own
 * DriverProfile records at sync time — that check happens later, on demand, when team building
 * picks a team and needs to verify its assigned drivers are actually on that roster. */
@Entity('iracing_teams')
export class IracingTeam {
  /** iRacing's own team_id — used directly as PK, same convention as IracingCar/IracingTrack. */
  @PrimaryColumn({ name: 'team_id' })
  teamId: number;

  @Column({ name: 'team_name' })
  teamName: string;

  @Column({ name: 'owner_cust_id' })
  ownerCustId: number;

  @Column({ name: 'roster_count', type: 'int' })
  rosterCount: number;

  @OneToMany(() => IracingTeamMember, (member) => member.team)
  members: Relation<IracingTeamMember>[];

  @UpdateDateColumn({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}
