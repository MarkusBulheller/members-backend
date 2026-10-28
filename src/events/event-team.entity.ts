import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { Event } from './event.entity.js';

/** One car/crew for an event, built by an admin from the confirmed signups — see
 * EventSignup.eventTeamId for how a driver is actually placed onto one. */
@Entity('event_teams')
export class EventTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Relation<Event>;

  @Index('idx_event_teams_event_id')
  @Column({ name: 'event_id' })
  eventId: string;

  @Column()
  name: string;

  /** Plain column, not a relation — keeps Events decoupled from the Cars module, same rationale
   * as EventSignup.carId. */
  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId: string | null;

  /** iRacing team catalog id (IracingTeam.teamId) this crew corresponds to, if any — lets the
   * frontend cross-check each assigned driver's iracingCustomerId against that team's synced
   * roster. Plain column, not a relation, since Events shouldn't depend on the Iracing module. */
  @Column({ name: 'iracing_team_id', type: 'int', nullable: true })
  iracingTeamId: number | null;

  /** Which of the event's candidate start times this crew has committed to racing — a team plans
   * one specific stint schedule, unlike EventSignup.timeslots (a driver can flag several options
   * before teams are built). Real relation (unlike carId/iracingTeamId) since EventTimeslot
   * already lives in this same module. */
  @ManyToOne(() => EventTimeslot, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'timeslot_id' })
  timeslot: Relation<EventTimeslot> | null;

  @Column({ name: 'timeslot_id', type: 'uuid', nullable: true })
  timeslotId: string | null;

  /** Race-planning settings for this crew's stint strategy (see EventTeamStint) — all optional,
   * filled in on the team's planning page. Decimal columns come back as strings, same convention
   * as CarTrackSetup.fuelPerLapLiters/pitLaneTimeSeconds (which the planning page pre-fills these
   * from, when this team has a car and the event has a track with a matching setup). */
  @Column({ name: 'refuel_duration_seconds', type: 'decimal', precision: 6, scale: 2, nullable: true })
  refuelDurationSeconds: string | null;

  @Column({ name: 'tyre_change_duration_seconds', type: 'decimal', precision: 6, scale: 2, nullable: true })
  tyreChangeDurationSeconds: string | null;

  /** LMU only: seconds for a pit stop that changes just 1-2 tyres (3-4 tyres use
   * tyreChangeDurationSeconds). Null = fall back to PARTIAL_TYRE_CHANGE_SECONDS_DEFAULT (5). */
  @Column({ name: 'partial_tyre_change_seconds', type: 'decimal', precision: 6, scale: 2, nullable: true })
  partialTyreChangeSeconds: string | null;

  @Column({ name: 'pitstop_drivethrough_seconds', type: 'decimal', precision: 6, scale: 2, nullable: true })
  pitstopDrivethroughSeconds: string | null;

  /** Tank size override in liters. Null = use the car's own tankCapacityLiters (the plan page
   * falls back to it), so this only holds a value when an admin deliberately overrides it. */
  @Column({ name: 'fuel_tank_capacity_liters', type: 'decimal', precision: 6, scale: 2, nullable: true })
  fuelTankCapacityLiters: string | null;

  /** Team-wide baseline, used for planning math that can't yet know which driver will be in a
   * given stint (max-stint-by-fuel, "Generate Full Stint Plan"). See EventTeamDriverSettings for
   * the per-driver figures that override this once a stint is actually assigned to someone. */
  @Column({ name: 'lap_time_dry_seconds', type: 'decimal', precision: 6, scale: 3, nullable: true })
  lapTimeDrySeconds: string | null;

  @Column({ name: 'lap_time_wet_seconds', type: 'decimal', precision: 6, scale: 3, nullable: true })
  lapTimeWetSeconds: string | null;

  @Column({ name: 'fuel_usage_per_lap_liters', type: 'decimal', precision: 5, scale: 3, nullable: true })
  fuelUsagePerLapLiters: string | null;

  /** Minutes between the timeslot's own startsAt (when the session/server opens) and the actual
   * green flag — a practice + qualifying block ahead of the race pushes the real start later than
   * the timeslot alone would suggest. The planning page's raceStartMs adds this on top. */
  @Column({ name: 'race_start_offset_minutes', type: 'decimal', precision: 6, scale: 2, nullable: true })
  raceStartOffsetMinutes: string | null;

  /** Fuel burned on the formation lap, in liters — comes off the *first* stint's usable tank only
   * (every later stint starts from a full tank at pit exit, no formation lap involved). */
  @Column({ name: 'formation_lap_fuel_liters', type: 'decimal', precision: 5, scale: 3, nullable: true })
  formationLapFuelLiters: string | null;

  /** In-game clock time ("HH:MM") at the moment this crew's first stint starts — iRacing sessions
   * can be configured to start at any time of day regardless of the real-world green-flag time,
   * so the Strategy table's "Sim Time" column offsets from this rather than from startsAt. */
  @Column({ name: 'sim_start_time_of_day', type: 'varchar', nullable: true })
  simStartTimeOfDay: string | null;

  /** Secret behind the public "Follow the race" link (GET /public/follow/:token): 32 random bytes,
   * base64url. Null = the link is off. `select: false` so it never rides along on the ordinary
   * team reads that every member can call (GET /events/:id/teams) — only FollowLinkService /
   * FollowStateService read it, by selecting it explicitly. Never logged. */
  @Index('uq_event_teams_follow_token', { unique: true, where: '"follow_token" IS NOT NULL' })
  @Column({ name: 'follow_token', type: 'varchar', length: 64, nullable: true, select: false })
  followToken: string | null;

  /** How driver names appear on the public follow page: 'FULL' | 'FIRST' | 'INITIALS'. */
  @Column({ name: 'follow_names', type: 'varchar', length: 10, default: 'FULL' })
  followNames: string;

  /** Discord thread created for this crew's race (see EventTeamThreadService). Null = none yet. */
  @Column({ name: 'discord_thread_id', type: 'varchar', nullable: true })
  discordThreadId: string | null;

  /** Placeholder / roster-guest drivers on this crew — see EventTeamDummyDriver. Only loaded by
   * EventTeamsService.listForEvent(). */
  @OneToMany(() => EventTeamDummyDriver, (dummy) => dummy.eventTeam)
  dummyDrivers?: Relation<EventTeamDummyDriver>[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
