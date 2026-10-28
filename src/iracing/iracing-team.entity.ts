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

  /** Admin-controlled: not every synced team is ours. Inactive teams are hidden from the default team
   * list/pickers and never auto-imported. The sync never touches this flag. */
  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** Watch this team for new race results (automatic import, see IracingResultAutoImportService).
   * Off until an admin ticks it; always off for an inactive team. The sync never touches it. */
  @Column({ name: 'auto_import', type: 'boolean', default: false })
  autoImport: boolean;

  /** Added by hand by an admin (a team we are not a member of, or one that no longer exists), so
   * there is no roster and no owner to sync: owner_cust_id and roster_count are 0. A later real
   * sync of the same team id turns this off again. */
  @Column({ type: 'boolean', default: false })
  manual: boolean;

  /** When the auto-import last searched iRacing for this team successfully. */
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  @OneToMany(() => IracingTeamMember, (member) => member.team)
  members: Relation<IracingTeamMember>[];

  @UpdateDateColumn({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}
