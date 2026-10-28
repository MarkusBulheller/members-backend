import type { Sim } from '../../common/enums/sim.enum.js';

/** Race-readiness check — response contract (shared with the portal) and the plain-data input the
 * pure rules engine works on. Nothing here touches the database. */

export type ReadinessLevel = 'BLOCKER' | 'WARNING' | 'INFO';
export type ReadinessStatus = 'PASS' | 'FAIL' | 'PENDING';

export interface ReadinessFix {
  kind: 'team-settings' | 'team-plan' | 'team-availability' | 'team-building' | 'event-edit' | 'signups';
  teamId?: string;
  /** Short action text, e.g. "Open settings". */
  label: string;
}

export interface ReadinessCheck {
  id: string;
  /** Severity IF the check fails. */
  level: ReadinessLevel;
  status: ReadinessStatus;
  title: string;
  detail?: string;
  fix?: ReadinessFix;
}

export interface ReadinessSummary {
  /** blockers / warnings / infos count FAILED checks only. */
  blockers: number;
  warnings: number;
  infos: number;
  pending: number;
  passed: number;
  status: 'READY' | 'WARNINGS' | 'BLOCKED' | 'PENDING';
}

export interface ReadinessTeam {
  teamId: string;
  teamName: string;
  summary: ReadinessSummary;
  checks: ReadinessCheck[];
}

export interface ReadinessResult {
  eventId: string;
  generatedAt: string;
  minDriversPerTeam: number;
  summary: ReadinessSummary;
  event: ReadinessCheck[];
  teams: ReadinessTeam[];
}

// ---------------------------------------------------------------------------------------------
// Engine input — plain data, decimals as the strings TypeORM returns them (parsed in the engine).
// ---------------------------------------------------------------------------------------------

/** The driver-profile fields the checks care about. */
export interface ReadinessDriverProfile {
  name: string;
  iracingCustomerId: string | null;
  maxSuccessiveStints: number | null;
  startingDriver: boolean;
  nightDriver: boolean;
}

export interface ReadinessMember {
  userId: string;
  name: string;
  availableHours: Date[];
  profile: ReadinessDriverProfile | null;
}

/** A dummy driver row: a roster guest when `driverProfileId` is set, a free-text placeholder otherwise. */
export interface ReadinessDummy {
  id: string;
  name: string;
  driverProfileId: string | null;
  availableHours: Date[];
  profile: ReadinessDriverProfile | null;
}

export interface ReadinessStintInput {
  id: string;
  order: number;
  driverUserId: string | null;
  durationMinutes: string | null;
  tyreChange: boolean;
  tyresChanged: number | null;
  actualStartAt: Date | null;
  wetOverride: boolean | null;
}

export interface ReadinessDriverSettings {
  userId: string;
  lapTimeDrySeconds: string | null;
  lapTimeWetSeconds: string | null;
  fuelUsagePerLapLiters: string | null;
}

export interface ReadinessTeamInput {
  id: string;
  name: string;
  carId: string | null;
  iracingTeamId: number | null;
  timeslotId: string | null;
  refuelDurationSeconds: string | null;
  tyreChangeDurationSeconds: string | null;
  partialTyreChangeSeconds: string | null;
  pitstopDrivethroughSeconds: string | null;
  fuelTankCapacityLiters: string | null;
  lapTimeDrySeconds: string | null;
  lapTimeWetSeconds: string | null;
  fuelUsagePerLapLiters: string | null;
  raceStartOffsetMinutes: string | null;
  formationLapFuelLiters: string | null;
  /** The car's own tank size (decimal string); null when the team has no car or it was not found. */
  carTankCapacityLiters: string | null;
  /** Non-cancelled signups placed on this team. */
  members: ReadinessMember[];
  dummies: ReadinessDummy[];
  /** In `order`. */
  stints: ReadinessStintInput[];
  driverSettings: ReadinessDriverSettings[];
}

export interface ReadinessSignupInput {
  userId: string;
  name: string;
  status: 'CONFIRMED' | 'WAITLISTED' | 'CANCELLED';
  eventTeamId: string | null;
}

export interface ReadinessGuestSignupInput {
  driverProfileId: string;
  name: string;
}

export interface ReadinessForecastPoint {
  time_offset: number;
  is_sun_up: boolean;
}

/** `OK` carries the points; `UNAVAILABLE` carries a human reason (fetch failed, expired link, ...). */
export type ReadinessForecastInput =
  | { state: 'OK'; points: ReadinessForecastPoint[] }
  | { state: 'UNAVAILABLE'; reason: string };

export interface ReadinessEventInput {
  id: string;
  sim: Sim;
  raceLengthMinutes: number;
  minDriversPerTeam: number | null;
  /** Percent string (e.g. "98.00"), iRacing only. */
  fuelLimitPercent: string | null;
  tyreLimit: number | null;
  iracingSeasonId: number | null;
  iracingRaceWeekNum: number | null;
}

export interface ReadinessInput {
  now: Date;
  event: ReadinessEventInput;
  timeslots: { id: string; startsAt: Date }[];
  teams: ReadinessTeamInput[];
  /** Every signup of the event (any status). */
  signups: ReadinessSignupInput[];
  /** Active (not cancelled) guest signups. */
  guestSignups: ReadinessGuestSignupInput[];
  /** iRacing team id -> cust ids on its synced roster. A missing key = roster never synced. */
  rosters: Record<number, number[]>;
  /** Display names for any driver id that can show up on a stint (users and dummy ids). */
  driverNames: Record<string, string>;
  /** Only supplied when the event is linked to an iRacing week; null otherwise. */
  forecast: ReadinessForecastInput | null;
}
