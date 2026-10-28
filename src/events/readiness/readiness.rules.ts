import { Sim } from '../../common/enums/sim.enum.js';
import { buildStintSlots } from '../event-team-upcoming-stints.service.js';
import {
  effectiveTankLiters,
  formatMinutes,
  longestRunsByDriver,
  maxStintMinutes,
  overlappingRaceHours,
  parseDecimal,
  tyresUsed,
  usableTankForStint,
} from './readiness.math.js';
import type {
  ReadinessCheck,
  ReadinessDriverProfile,
  ReadinessFix,
  ReadinessInput,
  ReadinessLevel,
  ReadinessResult,
  ReadinessStatus,
  ReadinessSummary,
  ReadinessTeam,
  ReadinessTeamInput,
} from './readiness.types.js';

/** Drivers a team needs when the event does not say otherwise. */
export const DEFAULT_MIN_DRIVERS_PER_TEAM = 4;
/** The plan may be this many minutes off the race length before it counts as not covering it. */
export const COVERAGE_TOLERANCE_MINUTES = 5;
/** Stored stint lengths are rounded to 0.1 min by the planner; allow that much slack on the fuel limit. */
export const STINT_FUEL_TOLERANCE_MINUTES = 0.1;
/** Share of the LMU tyre budget at which the "nearly used up" warning starts. */
export const TYRE_WARNING_RATIO = 0.9;
/** Longest list of offenders spelled out in a detail before it is cut with "and N more". */
const MAX_LISTED = 5;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function mk(
  id: string,
  level: ReadinessLevel,
  status: ReadinessStatus,
  title: string,
  detail?: string,
  fix?: ReadinessFix,
): ReadinessCheck {
  const check: ReadinessCheck = { id, level, status, title };
  // A passing/pending check may still carry an explanation, but the fix only makes sense on a failure.
  if (detail) check.detail = detail;
  if (fix && status === 'FAIL') check.fix = fix;
  return check;
}

function listNames(items: string[]): string {
  if (items.length <= MAX_LISTED) return items.join('; ');
  return `${items.slice(0, MAX_LISTED).join('; ')}; and ${items.length - MAX_LISTED} more`;
}

function fmtTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** Counts a list of checks. `hasTeams` and still-pending BLOCKER-level checks decide READY vs PENDING:
 * a team that has no stints yet isn't "ready", it just hasn't been set up (pending warnings/infos,
 * like an unavailable forecast, never hold READY back). */
export function summarizeChecks(checks: readonly ReadinessCheck[], hasTeams: boolean): ReadinessSummary {
  let blockers = 0;
  let warnings = 0;
  let infos = 0;
  let pending = 0;
  let pendingBlockers = 0;
  let passed = 0;
  for (const c of checks) {
    if (c.status === 'PENDING') {
      pending += 1;
      if (c.level === 'BLOCKER') pendingBlockers += 1;
    }
    else if (c.status === 'PASS') passed += 1;
    else if (c.level === 'BLOCKER') blockers += 1;
    else if (c.level === 'WARNING') warnings += 1;
    else infos += 1;
  }
  const status = blockers > 0 ? 'BLOCKED' : warnings > 0 ? 'WARNINGS' : !hasTeams || pendingBlockers > 0 ? 'PENDING' : 'READY';
  return { blockers, warnings, infos, pending, passed, status };
}

interface DriverRef {
  id: string;
  name: string;
  profile: ReadinessDriverProfile | null;
  /** null = unknown driver (no row to read hours from) -> never flagged. */
  availableHours: Date[] | null;
  isPlaceholder: boolean;
}

interface DriverInterval {
  driverId: string;
  teamId: string;
  teamName: string;
  stintNumber: number;
  startMs: number;
  endMs: number;
}

interface TeamEvaluation {
  checks: ReadinessCheck[];
  /** Driver intervals on the clock, for the cross-team clash check; empty when the team has no start time. */
  intervals: DriverInterval[];
}

// ---------------------------------------------------------------------------------------------
// Team checks
// ---------------------------------------------------------------------------------------------

function evaluateTeam(team: ReadinessTeamInput, input: ReadinessInput, minDrivers: number): TeamEvaluation {
  const { event } = input;
  const isIracing = event.sim === Sim.IRACING;
  const checks: ReadinessCheck[] = [];
  const fixBuilding = (label: string): ReadinessFix => ({ kind: 'team-building', teamId: team.id, label });
  const fixSettings: ReadinessFix = { kind: 'team-settings', teamId: team.id, label: 'Open settings' };
  const fixPlan = (label = 'Open plan'): ReadinessFix => ({ kind: 'team-plan', teamId: team.id, label });

  // Everyone who can appear on a stint, keyed by the id stints store (userId, or a dummy's own id).
  const refs = new Map<string, DriverRef>();
  for (const m of team.members) {
    refs.set(m.userId, { id: m.userId, name: m.name, profile: m.profile, availableHours: m.availableHours, isPlaceholder: false });
  }
  for (const d of team.dummies) {
    refs.set(d.id, {
      id: d.id,
      name: d.name,
      profile: d.profile,
      availableHours: d.availableHours,
      isPlaceholder: d.driverProfileId === null,
    });
  }
  const nameOf = (id: string): string => refs.get(id)?.name ?? input.driverNames[id] ?? 'Unknown driver';

  const timeslot = team.timeslotId ? input.timeslots.find((t) => t.id === team.timeslotId) : undefined;
  const offsetMinutes = parseDecimal(team.raceStartOffsetMinutes) ?? 0;
  const timeslotStartMs = timeslot ? timeslot.startsAt.getTime() : null;
  const raceStartMs = timeslotStartMs !== null ? timeslotStartMs + offsetMinutes * 60_000 : null;

  const stints = team.stints;
  const hasStints = stints.length > 0;
  // The same cascade the planner and the dashboard use. Without a start time the slots are anchored
  // at 0 — fine for length questions, never used for clock-time questions (those need raceStartMs).
  const slots = buildStintSlots(team, stints, raceStartMs ?? 0, '', () => null, event.sim).map((s) => ({
    startMs: Date.parse(s.startsAt),
    endMs: Date.parse(s.endsAt),
  }));
  const stintLabel = (index: number): string => {
    const driverId = stints[index].driverUserId;
    return driverId ? `Stint ${index + 1} (${nameOf(driverId)})` : `Stint ${index + 1}`;
  };

  // --- start time & car -----------------------------------------------------------------------
  checks.push(
    timeslot
      ? mk('team.start-time', 'BLOCKER', 'PASS', 'Start time chosen', `Starts ${timeslot.startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`)
      : mk('team.start-time', 'BLOCKER', 'FAIL', 'Start time chosen', 'This team has not committed to one of the event start times yet.', fixBuilding('Choose start time')),
  );
  checks.push(
    team.carId
      ? mk('team.car', 'BLOCKER', 'PASS', 'Car set')
      : mk('team.car', 'BLOCKER', 'FAIL', 'Car set', 'No car has been assigned to this team.', fixBuilding('Choose car')),
  );

  // --- plan settings ---------------------------------------------------------------------------
  const teamOverrideTank = parseDecimal(team.fuelTankCapacityLiters);
  const tankLiters = effectiveTankLiters(
    teamOverrideTank,
    parseDecimal(team.carTankCapacityLiters),
    parseDecimal(event.fuelLimitPercent),
    isIracing,
  );
  const teamFuelPerLap = parseDecimal(team.fuelUsagePerLapLiters);
  const teamLapDry = parseDecimal(team.lapTimeDrySeconds);
  const teamLapWet = parseDecimal(team.lapTimeWetSeconds);
  const refuelSeconds = parseDecimal(team.refuelDurationSeconds);
  const tyreSeconds = parseDecimal(team.tyreChangeDurationSeconds);
  const driveSeconds = parseDecimal(team.pitstopDrivethroughSeconds);

  // Same completeness rule as the planner's readyToGeneratePlan, minus the wet lap time (its own
  // warning below): tank, fuel/lap, dry lap, refuel, tyre change, drive-through all set and a
  // max stint length computable.
  const missing: string[] = [];
  if (tankLiters === null || tankLiters <= 0) missing.push('fuel tank size (set a car or a tank override)');
  if (teamFuelPerLap === null || teamFuelPerLap <= 0) missing.push('fuel per lap');
  if (teamLapDry === null || teamLapDry <= 0) missing.push('dry lap time');
  if (refuelSeconds === null) missing.push('refuel time');
  if (tyreSeconds === null) missing.push('tyre change time');
  if (driveSeconds === null) missing.push('drive-through time');
  checks.push(
    missing.length === 0
      ? mk('team.settings', 'BLOCKER', 'PASS', 'Plan settings complete')
      : mk('team.settings', 'BLOCKER', 'FAIL', 'Plan settings complete', `Missing: ${missing.join(', ')}.`, fixSettings),
  );
  checks.push(
    teamLapWet !== null
      ? mk('team.wet-lap-time', 'WARNING', 'PASS', 'Wet lap time set')
      : mk('team.wet-lap-time', 'WARNING', 'FAIL', 'Wet lap time set', 'Without it the planner cannot size stints for rain.', fixSettings),
  );

  // --- drivers ---------------------------------------------------------------------------------
  const realDriverNames = [
    ...team.members.map((m) => m.name),
    ...team.dummies.filter((d) => d.driverProfileId !== null).map((d) => d.name),
  ];
  checks.push(
    realDriverNames.length >= minDrivers
      ? mk('team.drivers', 'BLOCKER', 'PASS', `At least ${minDrivers} drivers`, `${realDriverNames.length} drivers: ${listNames(realDriverNames)}`)
      : mk(
          'team.drivers',
          'BLOCKER',
          'FAIL',
          `At least ${minDrivers} drivers`,
          `${realDriverNames.length} of ${minDrivers} needed${realDriverNames.length > 0 ? ` (${listNames(realDriverNames)})` : ''}. Placeholder drivers do not count.`,
          fixBuilding('Add drivers'),
        ),
  );

  if (isIracing) {
    checks.push(rosterCheck(team, input, fixBuilding));
  }

  const placeholders = team.dummies.filter((d) => d.driverProfileId === null);
  checks.push(
    placeholders.length === 0
      ? mk('team.placeholders', 'WARNING', 'PASS', 'No placeholder drivers')
      : mk(
          'team.placeholders',
          'WARNING',
          'FAIL',
          'No placeholder drivers',
          `Placeholder drivers on the plan: ${placeholders.map((d) => d.name).join(', ')}. Replace them with real drivers before the race.`,
          fixPlan(),
        ),
  );

  // --- stints ----------------------------------------------------------------------------------
  checks.push(
    hasStints
      ? mk('team.stints-exist', 'BLOCKER', 'PASS', 'Stints planned', `${stints.length} stints`)
      : mk('team.stints-exist', 'BLOCKER', 'PENDING', 'Stints planned', 'No stints planned yet.'),
  );

  if (!hasStints) {
    checks.push(mk('team.stint-drivers', 'BLOCKER', 'PENDING', 'Every stint has a driver', 'No stints planned yet.'));
  } else {
    const unassigned = stints.flatMap((s, i) => (s.driverUserId === null ? [`Stint ${i + 1}`] : []));
    checks.push(
      unassigned.length === 0
        ? mk('team.stint-drivers', 'BLOCKER', 'PASS', 'Every stint has a driver')
        : mk('team.stint-drivers', 'BLOCKER', 'FAIL', 'Every stint has a driver', `No driver on: ${listNames(unassigned)}.`, fixPlan('Assign drivers')),
    );
  }

  // Race coverage: end of the last stint (stored durations + the team's pit times) vs race length.
  if (!hasStints) {
    checks.push(mk('team.plan-coverage', 'BLOCKER', 'PENDING', 'Plan covers the race length', 'No stints planned yet.'));
  } else {
    const plannedMinutes = (slots[slots.length - 1].endMs - slots[0].startMs) / 60_000;
    const diff = plannedMinutes - event.raceLengthMinutes;
    const noDuration = stints.flatMap((s, i) => (parseDecimal(s.durationMinutes) ? [] : [`Stint ${i + 1}`]));
    const notes: string[] = [];
    if (noDuration.length > 0) notes.push(`No length set on: ${listNames(noDuration)}.`);
    if (refuelSeconds === null || tyreSeconds === null || driveSeconds === null) {
      notes.push('Pit times that are not set count as 0.');
    }
    const summary = `The plan covers ${formatMinutes(plannedMinutes)} of the ${formatMinutes(event.raceLengthMinutes)} race`;
    checks.push(
      Math.abs(diff) <= COVERAGE_TOLERANCE_MINUTES
        ? mk('team.plan-coverage', 'BLOCKER', 'PASS', 'Plan covers the race length', [summary + '.', ...notes].join(' '))
        : mk(
            'team.plan-coverage',
            'BLOCKER',
            'FAIL',
            'Plan covers the race length',
            [`${summary} (${formatMinutes(Math.abs(diff))} ${diff < 0 ? 'short' : 'too long'}).`, ...notes].join(' '),
            fixPlan(diff < 0 ? 'Add stints' : 'Trim plan'),
          ),
    );
  }

  checks.push(fuelCheck(team, { tankLiters, teamFuelPerLap, teamLapDry, teamLapWet, stintLabel }, fixPlan));
  checks.push(availabilityCheck(team, slots, timeslotStartMs, refs, stintLabel));

  // --- successive stints -----------------------------------------------------------------------
  if (!hasStints) {
    checks.push(mk('team.successive-stints', 'WARNING', 'PENDING', 'Within successive-stint limits', 'No stints planned yet.'));
  } else {
    const runs = longestRunsByDriver(stints.map((s) => s.driverUserId));
    const over: string[] = [];
    for (const [driverId, run] of runs) {
      const max = refs.get(driverId)?.profile?.maxSuccessiveStints;
      if (max && max > 0 && run > max) over.push(`${nameOf(driverId)}: ${run} in a row (max ${max})`);
    }
    checks.push(
      over.length === 0
        ? mk('team.successive-stints', 'WARNING', 'PASS', 'Within successive-stint limits')
        : mk('team.successive-stints', 'WARNING', 'FAIL', 'Within successive-stint limits', `${listNames(over)}.`, fixPlan()),
    );
  }

  // --- LMU tyres -------------------------------------------------------------------------------
  if (event.sim === Sim.LMU && event.tyreLimit !== null) {
    checks.push(...tyreChecks(team, event.tyreLimit, fixPlan));
  }

  // --- night stints (needs the weather forecast) -------------------------------------------------
  if (isIracing && input.forecast !== null) {
    checks.push(nightCheck(team, input, raceStartMs, slots, refs, stintLabel, fixPlan));
  }

  // --- starting driver -------------------------------------------------------------------------
  if (!hasStints) {
    checks.push(mk('team.starting-driver', 'INFO', 'PENDING', 'First stint driven by a starting driver', 'No stints planned yet.'));
  } else {
    const firstId = stints[0].driverUserId;
    const profile = firstId ? refs.get(firstId)?.profile : null;
    if (!firstId) {
      checks.push(mk('team.starting-driver', 'INFO', 'PENDING', 'First stint driven by a starting driver', 'The first stint has no driver yet.'));
    } else if (!profile) {
      checks.push(mk('team.starting-driver', 'INFO', 'PENDING', 'First stint driven by a starting driver', `${nameOf(firstId)} has no driver profile to read the preference from.`));
    } else if (profile.startingDriver) {
      checks.push(mk('team.starting-driver', 'INFO', 'PASS', 'First stint driven by a starting driver', nameOf(firstId)));
    } else {
      checks.push(
        mk(
          'team.starting-driver',
          'INFO',
          'FAIL',
          'First stint driven by a starting driver',
          `${nameOf(firstId)} opens the race but is not marked as a starting driver.`,
          fixPlan(),
        ),
      );
    }
  }

  // Intervals for the cross-team clash check.
  const intervals: DriverInterval[] =
    raceStartMs === null
      ? []
      : stints.flatMap((s, i) =>
          s.driverUserId
            ? [{ driverId: s.driverUserId, teamId: team.id, teamName: team.name, stintNumber: i + 1, startMs: slots[i].startMs, endMs: slots[i].endMs }]
            : [],
        );
  return { checks, intervals };
}

/** iRacing: every driver with a profile must be on the roster of the team's iRacing team. */
function rosterCheck(
  team: ReadinessTeamInput,
  input: ReadinessInput,
  fixBuilding: (label: string) => ReadinessFix,
): ReadinessCheck {
  const title = 'Drivers are on the iRacing team roster';
  if (team.iracingTeamId === null) {
    return mk('team.iracing-roster', 'BLOCKER', 'PENDING', title, 'No iRacing team selected for this team yet.');
  }
  const roster = input.rosters[team.iracingTeamId];
  if (!roster) {
    return mk('team.iracing-roster', 'BLOCKER', 'PENDING', title, 'The roster of the selected iRacing team has not been synced yet.');
  }
  const drivers = [
    ...team.members.map((m) => ({ name: m.name, profile: m.profile })),
    ...team.dummies.filter((d) => d.driverProfileId !== null).map((d) => ({ name: d.name, profile: d.profile })),
  ];
  if (drivers.length === 0) {
    return mk('team.iracing-roster', 'BLOCKER', 'PENDING', title, 'No drivers on this team yet.');
  }
  const rosterIds = new Set(roster);
  const problems: string[] = [];
  for (const d of drivers) {
    const raw = d.profile?.iracingCustomerId ?? null;
    if (raw === null || raw === '') {
      problems.push(`${d.name} (iRacing account not linked)`);
    } else if (!rosterIds.has(Number(raw))) {
      problems.push(`${d.name} (not on the iRacing team roster)`);
    }
  }
  return problems.length === 0
    ? mk('team.iracing-roster', 'BLOCKER', 'PASS', title)
    : mk('team.iracing-roster', 'BLOCKER', 'FAIL', title, `${listNames(problems)}.`, fixBuilding('Open team building'));
}

/** A stint longer than a tank allows — per stint, using the assigned driver's own pace/fuel when set. */
function fuelCheck(
  team: ReadinessTeamInput,
  ctx: {
    tankLiters: number | null;
    teamFuelPerLap: number | null;
    teamLapDry: number | null;
    teamLapWet: number | null;
    stintLabel: (index: number) => string;
  },
  fixPlan: (label?: string) => ReadinessFix,
): ReadinessCheck {
  const title = 'No stint longer than a tank allows';
  if (team.stints.length === 0) return mk('team.stint-fuel', 'BLOCKER', 'PENDING', title, 'No stints planned yet.');
  const formationFuel = parseDecimal(team.formationLapFuelLiters) ?? 0;
  const settingsByDriver = new Map(team.driverSettings.map((s) => [s.userId, s]));

  const problems: string[] = [];
  let evaluated = 0;
  team.stints.forEach((stint, index) => {
    const planned = parseDecimal(stint.durationMinutes);
    if (!planned) return;
    const driver = stint.driverUserId ? settingsByDriver.get(stint.driverUserId) : undefined;
    const driverDry = parseDecimal(driver?.lapTimeDrySeconds);
    const driverWet = parseDecimal(driver?.lapTimeWetSeconds);
    // Only an explicit wet override is known here; forecast-driven wet detection lives on the plan page.
    const lap = stint.wetOverride === true ? (driverWet ?? ctx.teamLapWet ?? driverDry ?? ctx.teamLapDry) : (driverDry ?? ctx.teamLapDry);
    const fuel = parseDecimal(driver?.fuelUsagePerLapLiters) ?? ctx.teamFuelPerLap;
    const max = maxStintMinutes(usableTankForStint(ctx.tankLiters, formationFuel, index === 0), fuel, lap);
    if (max === null) return;
    evaluated += 1;
    if (planned > max + STINT_FUEL_TOLERANCE_MINUTES) {
      problems.push(`${ctx.stintLabel(index)}: ${formatMinutes(planned)} planned, ${formatMinutes(max)} fits in a tank`);
    }
  });
  if (evaluated === 0) {
    return mk('team.stint-fuel', 'BLOCKER', 'PENDING', title, 'Needs fuel per lap, a lap time, a tank size and stint lengths to evaluate.');
  }
  return problems.length === 0
    ? mk('team.stint-fuel', 'BLOCKER', 'PASS', title)
    : mk('team.stint-fuel', 'BLOCKER', 'FAIL', title, `${listNames(problems)}.`, fixPlan('Shorten stints'));
}

/** A stint that runs into an hour its driver did not mark as available (WARNING). */
function availabilityCheck(
  team: ReadinessTeamInput,
  slots: { startMs: number; endMs: number }[],
  timeslotStartMs: number | null,
  refs: Map<string, DriverRef>,
  stintLabel: (index: number) => string,
): ReadinessCheck {
  const title = "Stints fall within drivers' available hours";
  const fix: ReadinessFix = { kind: 'team-availability', teamId: team.id, label: 'Open availability' };
  if (team.stints.length === 0) return mk('team.availability', 'WARNING', 'PENDING', title, 'No stints planned yet.');
  if (timeslotStartMs === null) return mk('team.availability', 'WARNING', 'PENDING', title, 'Needs a start time to place stints on the clock.');

  const problems: string[] = [];
  team.stints.forEach((stint, index) => {
    const ref = stint.driverUserId ? refs.get(stint.driverUserId) : undefined;
    // No marked hours (or an unknown driver) = unrestricted.
    if (!ref?.availableHours || ref.availableHours.length === 0) return;
    const { startMs, endMs } = slots[index];
    const spanMs = endMs - startMs;
    const hours = overlappingRaceHours(timeslotStartMs, startMs, startMs + (spanMs > 0 ? spanMs : 60 * 60_000));
    const marked = new Set(ref.availableHours.map((h) => h.getTime()));
    if (hours.length > 0 && !hours.every((h) => marked.has(h))) {
      problems.push(`${stintLabel(index)} runs ${fmtTime(startMs)}-${fmtTime(endMs)}`);
    }
  });
  return problems.length === 0
    ? mk('team.availability', 'WARNING', 'PASS', title)
    : mk('team.availability', 'WARNING', 'FAIL', title, `Outside marked hours: ${listNames(problems)}.`, fix);
}

/** LMU: tyres used against the event's budget — over = blocker, 90%+ = warning. */
function tyreChecks(
  team: ReadinessTeamInput,
  limit: number,
  fixPlan: (label?: string) => ReadinessFix,
): ReadinessCheck[] {
  const exceedTitle = 'Within the tyre limit';
  const nearTitle = 'Tyre budget not nearly used up';
  if (team.stints.length === 0) {
    return [
      mk('team.tyre-limit', 'BLOCKER', 'PENDING', exceedTitle, 'No stints planned yet.'),
      mk('team.tyre-limit-near', 'WARNING', 'PENDING', nearTitle, 'No stints planned yet.'),
    ];
  }
  const used = tyresUsed(team.stints);
  const summary = `${used} of ${limit} tyres used (including the 4 starting tyres)`;
  if (used > limit) {
    return [
      mk('team.tyre-limit', 'BLOCKER', 'FAIL', exceedTitle, `${summary} - ${used - limit} over the limit.`, fixPlan('Reduce tyre changes')),
      // Already reported as a blocker above; do not double-count it as a warning.
      mk('team.tyre-limit-near', 'WARNING', 'PASS', nearTitle, 'Covered by the tyre-limit blocker.'),
    ];
  }
  const near = used >= limit * TYRE_WARNING_RATIO;
  return [
    mk('team.tyre-limit', 'BLOCKER', 'PASS', exceedTitle, summary),
    near
      ? mk('team.tyre-limit-near', 'WARNING', 'FAIL', nearTitle, `${summary} - ${limit - used} spare.`, fixPlan())
      : mk('team.tyre-limit-near', 'WARNING', 'PASS', nearTitle, summary),
  ];
}

/** Night stints given to drivers not marked as night drivers — best-effort, needs the forecast. */
function nightCheck(
  team: ReadinessTeamInput,
  input: ReadinessInput,
  raceStartMs: number | null,
  slots: { startMs: number; endMs: number }[],
  refs: Map<string, DriverRef>,
  stintLabel: (index: number) => string,
  fixPlan: (label?: string) => ReadinessFix,
): ReadinessCheck {
  const title = 'Night stints go to night drivers';
  const forecast = input.forecast;
  if (forecast === null || forecast.state === 'UNAVAILABLE') {
    return mk('team.night-drivers', 'WARNING', 'PENDING', title, forecast ? `Weather forecast unavailable: ${forecast.reason}` : 'No weather forecast.');
  }
  if (forecast.points.length === 0) return mk('team.night-drivers', 'WARNING', 'PENDING', title, 'The weather forecast is empty.');
  if (team.stints.length === 0) return mk('team.night-drivers', 'WARNING', 'PENDING', title, 'No stints planned yet.');
  if (raceStartMs === null) return mk('team.night-drivers', 'WARNING', 'PENDING', title, 'Needs a start time to line stints up with the forecast.');

  const problems: string[] = [];
  team.stints.forEach((stint, index) => {
    const profile = stint.driverUserId ? refs.get(stint.driverUserId)?.profile : null;
    if (!profile || profile.nightDriver) return;
    const offsetMinutes = (slots[index].startMs - raceStartMs) / 60_000;
    // Nearest forecast point to the stint start, same pick as the plan page's nearestWeatherPoint.
    const point = forecast.points.reduce((best, p) =>
      Math.abs(p.time_offset - offsetMinutes) < Math.abs(best.time_offset - offsetMinutes) ? p : best,
    );
    if (!point.is_sun_up) problems.push(`${stintLabel(index)} starts at ${fmtTime(slots[index].startMs)}`);
  });
  return problems.length === 0
    ? mk('team.night-drivers', 'WARNING', 'PASS', title)
    : mk('team.night-drivers', 'WARNING', 'FAIL', title, `Driven in the dark by drivers not marked as night drivers: ${listNames(problems)}.`, fixPlan());
}

// ---------------------------------------------------------------------------------------------
// Event checks
// ---------------------------------------------------------------------------------------------

function evaluateEventChecks(input: ReadinessInput, intervals: DriverInterval[]): ReadinessCheck[] {
  const { event, teams } = input;
  const checks: ReadinessCheck[] = [];
  const noTeams = teams.length === 0;
  const signupsFix: ReadinessFix = { kind: 'signups', label: 'Open signups' };
  const teamIds = new Set(teams.map((t) => t.id));

  checks.push(
    noTeams
      ? mk('event.teams-exist', 'BLOCKER', 'PENDING', 'At least one team exists', 'No teams yet.')
      : mk('event.teams-exist', 'BLOCKER', 'PASS', 'At least one team exists', `${teams.length} team${teams.length === 1 ? '' : 's'}`),
  );

  const confirmedUnplaced = input.signups.filter(
    (s) => s.status === 'CONFIRMED' && (s.eventTeamId === null || !teamIds.has(s.eventTeamId)),
  );
  checks.push(
    noTeams
      ? mk('event.unplaced-drivers', 'WARNING', 'PENDING', 'Signed-up drivers are on a team', 'No teams yet.')
      : confirmedUnplaced.length === 0
        ? mk('event.unplaced-drivers', 'WARNING', 'PASS', 'Signed-up drivers are on a team')
        : mk(
            'event.unplaced-drivers',
            'WARNING',
            'FAIL',
            'Signed-up drivers are on a team',
            `${confirmedUnplaced.length} confirmed driver${confirmedUnplaced.length === 1 ? ' is' : 's are'} not on any team: ${listNames(confirmedUnplaced.map((s) => s.name))}.`,
            { kind: 'team-building', label: 'Open team building' },
          ),
  );

  const waitlisted = input.signups.filter((s) => s.status === 'WAITLISTED');
  checks.push(
    waitlisted.length === 0
      ? mk('event.waitlisted', 'INFO', 'PASS', 'No waitlisted signups')
      : mk('event.waitlisted', 'INFO', 'FAIL', 'No waitlisted signups', `Waiting for a spot: ${listNames(waitlisted.map((s) => s.name))}.`, signupsFix),
  );

  const placedProfileIds = new Set(teams.flatMap((t) => t.dummies.flatMap((d) => (d.driverProfileId ? [d.driverProfileId] : []))));
  const unplacedGuests = input.guestSignups.filter((g) => !placedProfileIds.has(g.driverProfileId));
  checks.push(
    noTeams
      ? mk('event.unplaced-guests', 'WARNING', 'PENDING', 'Guest signups are on a team', 'No teams yet.')
      : unplacedGuests.length === 0
        ? mk('event.unplaced-guests', 'WARNING', 'PASS', 'Guest signups are on a team')
        : mk(
            'event.unplaced-guests',
            'WARNING',
            'FAIL',
            'Guest signups are on a team',
            `Guest${unplacedGuests.length === 1 ? '' : 's'} not on any team: ${listNames(unplacedGuests.map((g) => g.name))}.`,
            { kind: 'team-building', label: 'Open team building' },
          ),
  );

  if (event.sim === Sim.IRACING) {
    const linked = event.iracingSeasonId !== null && event.iracingRaceWeekNum !== null;
    checks.push(
      linked
        ? mk('event.forecast-linked', 'INFO', 'PASS', 'Linked to an iRacing week (weather forecast)')
        : mk(
            'event.forecast-linked',
            'INFO',
            'FAIL',
            'Linked to an iRacing week (weather forecast)',
            'Without a linked series week there is no weather forecast, so night and rain cannot be planned.',
            { kind: 'event-edit', label: 'Edit event' },
          ),
    );
  }

  checks.push(driverClashCheck(input, intervals));
  return checks;
}

/** The same driver on two teams' clocks at once. */
function driverClashCheck(input: ReadinessInput, intervals: DriverInterval[]): ReadinessCheck {
  const title = 'No driver is on two teams at the same time';
  if (intervals.length === 0) return mk('event.driver-clash', 'BLOCKER', 'PENDING', title, 'No timed stints yet.');

  const byDriver = new Map<string, DriverInterval[]>();
  for (const iv of intervals) byDriver.set(iv.driverId, [...(byDriver.get(iv.driverId) ?? []), iv]);

  const clashes: string[] = [];
  let firstTeamId: string | undefined;
  for (const [driverId, list] of byDriver) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.teamId === b.teamId) continue;
        if (a.startMs < b.endMs && b.startMs < a.endMs) {
          const name = input.driverNames[driverId] ?? 'Unknown driver';
          clashes.push(
            `${name}: ${a.teamName} stint ${a.stintNumber} (${fmtTime(a.startMs)}-${fmtTime(a.endMs)}) overlaps ${b.teamName} stint ${b.stintNumber} (${fmtTime(b.startMs)}-${fmtTime(b.endMs)})`,
          );
          firstTeamId ??= a.teamId;
        }
      }
    }
  }
  return clashes.length === 0
    ? mk('event.driver-clash', 'BLOCKER', 'PASS', title)
    : mk('event.driver-clash', 'BLOCKER', 'FAIL', title, `${listNames(clashes)}.`, { kind: 'team-plan', teamId: firstTeamId, label: 'Open plan' });
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/** Evaluates an event's race readiness from plain data — no I/O, deterministic for a given input. */
export function evaluateEventReadiness(input: ReadinessInput): ReadinessResult {
  const minDrivers = input.event.minDriversPerTeam ?? DEFAULT_MIN_DRIVERS_PER_TEAM;

  const evaluations = input.teams.map((team) => ({ team, ...evaluateTeam(team, input, minDrivers) }));
  const allIntervals = evaluations.flatMap((e) => e.intervals);
  const eventChecks = evaluateEventChecks(input, allIntervals);

  const teams: ReadinessTeam[] = evaluations.map((e) => ({
    teamId: e.team.id,
    teamName: e.team.name,
    summary: summarizeChecks(e.checks, true),
    checks: e.checks,
  }));

  return {
    eventId: input.event.id,
    generatedAt: input.now.toISOString(),
    minDriversPerTeam: minDrivers,
    summary: summarizeChecks([...eventChecks, ...evaluations.flatMap((e) => e.checks)], input.teams.length > 0),
    event: eventChecks,
    teams,
  };
}

/** What a non-admin member may see: only their own teams, no event-level checks, summary over those teams. */
export function restrictReadinessToTeams(result: ReadinessResult, teamIds: ReadonlySet<string>): ReadinessResult {
  const teams = result.teams.filter((t) => teamIds.has(t.teamId));
  return {
    ...result,
    summary: summarizeChecks(teams.flatMap((t) => t.checks), teams.length > 0),
    event: [],
    teams,
  };
}
