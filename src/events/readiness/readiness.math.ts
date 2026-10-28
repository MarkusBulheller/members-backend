/** Pure helpers ported 1:1 from the portal's race planner so the readiness check judges a plan by
 * exactly the rules the planner shows. Each names the portal source it mirrors. */

const MAX_TYRES_PER_STOP = 4;
const TYRES_AT_START = 4;

/** Decimal columns arrive as strings; anything unparsable is treated as "not set". */
export function parseDecimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The tank the plan actually works with (EventTeamPlanPage `tankCapacityLiters`): the team's own
 * override, else the car's tank, then — on an iRacing event with a fuel limit — only that percent
 * of it. Null when neither a team override nor a car tank is known. */
export function effectiveTankLiters(
  teamOverrideLiters: number | null,
  carTankLiters: number | null,
  fuelLimitPercent: number | null,
  isIracing: boolean,
): number | null {
  const maxTank = teamOverrideLiters ?? carTankLiters;
  if (maxTank === null) return null;
  const percent = isIracing ? (fuelLimitPercent ?? 100) : 100;
  return (maxTank * percent) / 100;
}

/** EventTeamPlanPage `maxStintMinutes`: whole laps a tank lasts (floor) times the lap time.
 * Null unless the tank, the fuel-per-lap (> 0) and the lap time are all set (the planner's checks
 * are plain truthiness, so a 0 tank or 0 lap time also yields null). */
export function maxStintMinutes(
  tankLiters: number | null,
  fuelPerLapLiters: number | null,
  lapTimeSeconds: number | null,
): number | null {
  const laps = tankLiters && fuelPerLapLiters && fuelPerLapLiters > 0 ? Math.floor(tankLiters / fuelPerLapLiters) : null;
  return laps !== null && lapTimeSeconds ? (laps * lapTimeSeconds) / 60 : null;
}

/** The planner's per-stint tank: the first stint loses the formation-lap fuel (later stints start
 * from a full tank at pit exit). Never negative. */
export function usableTankForStint(tankLiters: number | null, formationLapFuelLiters: number, isFirstStint: boolean): number | null {
  if (tankLiters === null) return null;
  return isFirstStint ? Math.max(0, tankLiters - formationLapFuelLiters) : tankLiters;
}

/** Start of every hour bucket (ms since epoch) a stint window touches, on the grid anchored at the
 * timeslot start (EventTeamPlanPage `overlappingRaceHours`). Driver availability is stored as
 * these same instants. */
export function overlappingRaceHours(timeslotStartMs: number, windowStartMs: number, windowEndMs: number): number[] {
  const firstK = Math.floor((windowStartMs - timeslotStartMs) / 3_600_000);
  const hours: number[] = [];
  for (let k = Math.max(firstK, 0); timeslotStartMs + k * 3_600_000 < windowEndMs; k++) {
    hours.push(timeslotStartMs + k * 3_600_000);
  }
  return hours;
}

/** portal lib/tyres.ts `tyresChangedOf`: null (legacy rows) -> 4 when the boolean says change, else 0. */
export function tyresChangedOf(stint: { tyreChange: boolean; tyresChanged: number | null }): number {
  if (stint.tyresChanged !== null && stint.tyresChanged !== undefined) {
    return Math.min(MAX_TYRES_PER_STOP, Math.max(0, Math.trunc(stint.tyresChanged)));
  }
  return stint.tyreChange ? MAX_TYRES_PER_STOP : 0;
}

/** portal lib/tyres.ts `tyresUsed`: the 4 starting tyres plus every later stint's changed tyres
 * (the first stint's own value is ignored). `stints` must be in race order. */
export function tyresUsed(stints: readonly { tyreChange: boolean; tyresChanged: number | null }[]): number {
  let used = TYRES_AT_START;
  for (let i = 1; i < stints.length; i += 1) used += tyresChangedOf(stints[i]);
  return used;
}

/** Longest run of consecutive stints (in the given order) per driver id; unassigned stints break runs. */
export function longestRunsByDriver(driverIdsInOrder: readonly (string | null)[]): Map<string, number> {
  const best = new Map<string, number>();
  let current: string | null = null;
  let run = 0;
  for (const id of driverIdsInOrder) {
    if (id !== null && id === current) {
      run += 1;
    } else {
      current = id;
      run = id === null ? 0 : 1;
    }
    if (id !== null && run > (best.get(id) ?? 0)) best.set(id, run);
  }
  return best;
}

/** "3h 05m" / "42m" for human-readable details. */
export function formatMinutes(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
