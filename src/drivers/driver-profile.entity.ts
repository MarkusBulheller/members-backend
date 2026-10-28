import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { AchievementAward } from '../achievements/achievement-award.entity.js';

@Entity('driver_profiles')
export class DriverProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null for a driver added manually by an admin (a guest/roster entry with no portal login) —
   * see DriversService.createManualDriver(). Postgres unique indexes allow multiple NULLs, so
   * any number of manual drivers can coexist alongside real members. */
  @Index({ unique: true })
  @Column({ name: 'user_id', type: 'varchar', unique: true, nullable: true })
  userId: string | null;

  @Column({ name: 'display_name' })
  displayName: string;

  /** Relative path under /uploads (e.g. "/uploads/avatars/<uuid>.png") — resolved to a full CDN
   * URL at read time on the frontend, same convention as Livery.imageUrl/Car.imageUrl. Settable
   * by the member themselves (see DriversController's "me/avatar" routes) or by an admin for any
   * driver, manual or linked (":id/avatar"). */
  @Column({ name: 'avatar_url', type: 'varchar', nullable: true })
  avatarUrl: string | null;

  /** The next five fields are a snapshot captured server-side at link time (see
   * members-backend/src/iracing/) via iRacing's OAuth — "iracing.profile" for name/cust_id,
   * "iracing.auth" + the Data API for location and Sports Car license stats. No refresh token
   * is stored; re-linking (the "Re-link" button) is how a member refreshes the snapshot. */
  @Index({ unique: true })
  @Column({ name: 'iracing_customer_id', type: 'varchar', nullable: true })
  iracingCustomerId: string | null;

  @Column({ name: 'iracing_name', type: 'varchar', nullable: true })
  iracingName: string | null;

  @Column({ name: 'iracing_location', type: 'varchar', nullable: true })
  iracingLocation: string | null;

  /** ISO 3166-1 alpha-2 code (e.g. "DE") — used to render a nationality flag, distinct from the
   * human-readable iracingLocation string. */
  @Column({ name: 'iracing_country_code', type: 'varchar', nullable: true })
  iracingCountryCode: string | null;

  @Column({ name: 'sports_car_irating', type: 'int', nullable: true })
  sportsCarIrating: number | null;

  /** Formatted as iRacing displays it, e.g. "A 4.99" (license class + safety rating). */
  @Column({ name: 'sports_car_safety_rating', type: 'varchar', nullable: true })
  sportsCarSafetyRating: string | null;

  /** iRacing single-use refresh token from the member's most recent link/re-link — used by the
   * weekly cron (see IracingStatsSyncService) to silently refresh sportsCarIrating/
   * sportsCarSafetyRating without asking the member to re-link. `select: false` keeps it out of
   * every normal query (including anything returned to the frontend) — it must be explicitly
   * selected. Cleared to null if a refresh attempt is rejected (revoked/expired), which is this
   * app's signal that the member needs to click "Re-link" again. */
  @Column({ name: 'iracing_refresh_token', type: 'varchar', nullable: true, select: false })
  iracingRefreshToken: string | null;

  @Column({ name: 'iracing_stats_synced_at', type: 'timestamptz', nullable: true })
  iracingStatsSyncedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  country: string | null;

  /** IANA timezone name (e.g. "America/Los_Angeles") — self-set on the driver's own profile, used
   * to show a stint's start/end in each assigned driver's own local time on the race-planning page. */
  @Column({ type: 'varchar', nullable: true })
  timezone: string | null;

  /** Comma-separated list, e.g. "GT3, GTP" — kept as a plain string rather than a Postgres
   * array column so it's trivial to render/edit as a single text input on the frontend. */
  @Column({ name: 'preferred_classes', type: 'varchar', nullable: true })
  preferredClasses: string | null;

  @Column({ nullable: true, type: 'text' })
  bio: string | null;

  /** Endurance-planning flags — how many stints in a row this driver can do before needing a
   * break, and which conditions they're suited/willing to drive. Self-set (or admin-set for a
   * manual driver), feeding future stint-assignment tooling rather than purely descriptive. */
  @Column({ name: 'max_successive_stints', type: 'int', nullable: true })
  maxSuccessiveStints: number | null;

  @Column({ name: 'starting_driver', default: false })
  startingDriver: boolean;

  @Column({ name: 'wet_driver', default: false })
  wetDriver: boolean;

  @Column({ name: 'night_driver', default: false })
  nightDriver: boolean;

  /** Opt-in: send this member a private Discord message with their personal race summary after a
   * result they drove in is imported (see RaceSummaryDmService). Only meaningful for portal
   * members (userId set). */
  @Column({ name: 'race_summary_dm', type: 'boolean', default: false })
  raceSummaryDm: boolean;

  /** Discord username (the handle, stored normalised: trimmed, no "@", lower-case) of a MANUALLY
   * ADDED driver, set by an admin so a guest with no portal account can sign up through Discord.
   * Unique when set. `select: false` keeps it out of the public roster list and other normal
   * reads. In responses, DriversService.withDiscordUsernameFor() fills this property per request:
   * a portal member's handle (users.discord_username) for the profile's owner and admins, a
   * guest's stored username for admins only, null otherwise. */
  @Index('uq_driver_profiles_discord_username', { unique: true })
  @Column({ name: 'discord_username', type: 'varchar', length: 32, nullable: true, select: false })
  discordUsername?: string | null;

  /** SYSTEM-MANAGED binding to a guest's Discord user id (snowflake), filled the first time the
   * bot sees that Discord user matching `discordUsername` (DriversService.findGuestByDiscordIdentity).
   * Never admin-editable and never sent to the portal (`select: false`); cleared whenever an admin
   * changes or clears the username, so the old person's identity can't carry over. Unique when set. */
  @Index('uq_driver_profiles_discord_id', { unique: true })
  @Column({ name: 'discord_id', type: 'varchar', length: 20, nullable: true, select: false })
  discordId: string | null;

  @OneToMany(() => AchievementAward, (award) => award.driverProfile)
  awards: Relation<AchievementAward>[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
