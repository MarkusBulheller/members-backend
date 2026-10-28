import { describe, expect, it } from 'vitest';
import { Sim } from '../../common/enums/sim.enum.js';
import {
  DEFAULT_MIN_DRIVERS_PER_TEAM,
  evaluateEventReadiness,
  restrictReadinessToTeams,
  summarizeChecks,
} from './readiness.rules.js';
import type {
  ReadinessCheck,
  ReadinessDriverProfile,
  ReadinessInput,
  ReadinessMember,
  ReadinessResult,
  ReadinessStintInput,
  ReadinessTeamInput,
} from './readiness.types.js';

const START = new Date('2026-10-24T12:00:00.000Z');
const HOUR = 3_600_000;

function profile(name: string, cust: string, extra: Partial<ReadinessDriverProfile> = {}): ReadinessDriverProfile {
  return { name, iracingCustomerId: cust, maxSuccessiveStints: null, startingDriver: false, nightDriver: true, ...extra };
}

function member(id: string, cust: string, extra: Partial<ReadinessDriverProfile> = {}, hours: Date[] = []): ReadinessMember {
  const p = profile(`Driver ${id}`, cust, extra);
  return { userId: id, name: p.name, availableHours: hours, profile: p };
}

function stint(order: number, driver: string | null, duration: string | null, extra: Partial<ReadinessStintInput> = {}): ReadinessStintInput {
  return {
    id: `s${order}`,
    order,
    driverUserId: driver,
    durationMinutes: duration,
    tyreChange: true,
    tyresChanged: null,
    actualStartAt: null,
    wetOverride: null,
    ...extra,
  };
}

/** A fully ready iRacing team: 4 drivers on the roster, 5 stints covering 4h (4x55 + 15 min plus 4
 * pit stops of 1.5 min = 241 min), every stint exactly one tank (33 laps x 100 s = 55 min). */
function goodTeam(id = 't1', name = 'Team One'): ReadinessTeamInput {
  return {
    id,
    name,
    carId: 'car1',
    iracingTeamId: 500,
    timeslotId: 'ts1',
    refuelDurationSeconds: '30',
    tyreChangeDurationSeconds: '60',
    partialTyreChangeSeconds: null,
    pitstopDrivethroughSeconds: '0',
    fuelTankCapacityLiters: null,
    lapTimeDrySeconds: '100',
    lapTimeWetSeconds: '108',
    fuelUsagePerLapLiters: '3',
    raceStartOffsetMinutes: null,
    formationLapFuelLiters: '0',
    carTankCapacityLiters: '100',
    members: [
      member('u1', '1001', { startingDriver: true }),
      member('u2', '1002'),
      member('u3', '1003'),
      member('u4', '1004'),
    ],
    dummies: [],
    stints: [
      stint(1, 'u1', '55'),
      stint(2, 'u2', '55'),
      stint(3, 'u3', '55'),
      stint(4, 'u4', '55'),
      stint(5, 'u1', '15'),
    ],
    driverSettings: [],
  };
}

function goodInput(): ReadinessInput {
  return {
    now: new Date('2026-10-20T10:00:00.000Z'),
    event: {
      id: 'e1',
      sim: Sim.IRACING,
      raceLengthMinutes: 240,
      minDriversPerTeam: null,
      fuelLimitPercent: null,
      tyreLimit: null,
      iracingSeasonId: 1,
      iracingRaceWeekNum: 3,
    },
    timeslots: [{ id: 'ts1', startsAt: START }],
    teams: [goodTeam()],
    signups: ['u1', 'u2', 'u3', 'u4'].map((u) => ({
      userId: u,
      name: `Driver ${u}`,
      status: 'CONFIRMED' as const,
      eventTeamId: 't1',
    })),
    guestSignups: [],
    rosters: { 500: [1001, 1002, 1003, 1004] },
    driverNames: { u1: 'Driver u1', u2: 'Driver u2', u3: 'Driver u3', u4: 'Driver u4' },
    forecast: { state: 'OK', points: [{ time_offset: 0, is_sun_up: true }, { time_offset: 240, is_sun_up: true }] },
  };
}

function evaluate(mutate?: (input: ReadinessInput) => void): ReadinessResult {
  const input = goodInput();
  mutate?.(input);
  return evaluateEventReadiness(input);
}

function teamCheck(result: ReadinessResult, id: string, teamIndex = 0): ReadinessCheck {
  const found = result.teams[teamIndex].checks.find((c) => c.id === id);
  if (!found) throw new Error(`team check ${id} not present`);
  return found;
}

function eventCheck(result: ReadinessResult, id: string): ReadinessCheck {
  const found = result.event.find((c) => c.id === id);
  if (!found) throw new Error(`event check ${id} not present`);
  return found;
}

describe('baseline', () => {
  it('a fully prepared iRacing event is READY with no failures', () => {
    const result = evaluate();
    const all = [...result.event, ...result.teams.flatMap((t) => t.checks)];
    expect(all.filter((c) => c.status !== 'PASS').map((c) => `${c.id}:${c.status}`)).toEqual([]);
    expect(result.summary.status).toBe('READY');
    expect(result.summary.blockers).toBe(0);
    expect(result.minDriversPerTeam).toBe(DEFAULT_MIN_DRIVERS_PER_TEAM);
    expect(result.eventId).toBe('e1');
    expect(result.generatedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('every failing check carries a detail and a fix', () => {
    const result = evaluate((i) => {
      const t = i.teams[0];
      t.timeslotId = null;
      t.carId = null;
      t.stints[1].driverUserId = null;
      t.dummies.push({ id: 'd1', name: 'TBD', driverProfileId: null, availableHours: [], profile: null });
    });
    const failed = result.teams[0].checks.filter((c) => c.status === 'FAIL');
    expect(failed.length).toBeGreaterThan(2);
    for (const c of failed) {
      expect(c.detail, c.id).toBeTruthy();
      expect(c.fix, c.id).toBeTruthy();
    }
  });
});

describe('team.start-time', () => {
  it('passes with a chosen timeslot, fails without', () => {
    expect(teamCheck(evaluate(), 'team.start-time').status).toBe('PASS');
    const failed = teamCheck(evaluate((i) => (i.teams[0].timeslotId = null)), 'team.start-time');
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('BLOCKER');
    expect(failed.fix).toEqual({ kind: 'team-building', teamId: 't1', label: 'Choose start time' });
  });

  it('fails when the timeslot id no longer exists', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].timeslotId = 'gone')), 'team.start-time').status).toBe('FAIL');
  });
});

describe('team.car', () => {
  it('passes with a car, fails without', () => {
    expect(teamCheck(evaluate(), 'team.car').status).toBe('PASS');
    const failed = teamCheck(evaluate((i) => (i.teams[0].carId = null)), 'team.car');
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('BLOCKER');
  });
});

describe('team.settings', () => {
  it('passes when every planner field is set (wet lap time is its own check)', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].lapTimeWetSeconds = null)), 'team.settings').status).toBe('PASS');
  });

  it('fails listing exactly the missing fields', () => {
    const result = evaluate((i) => {
      const t = i.teams[0];
      t.refuelDurationSeconds = null;
      t.fuelUsagePerLapLiters = null;
      t.lapTimeDrySeconds = null;
    });
    const c = teamCheck(result, 'team.settings');
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('BLOCKER');
    expect(c.detail).toContain('refuel time');
    expect(c.detail).toContain('fuel per lap');
    expect(c.detail).toContain('dry lap time');
    expect(c.detail).not.toContain('tyre change');
    expect(c.fix?.kind).toBe('team-settings');
  });

  it('resolves the tank from the team override when the car has none', () => {
    const noTank = evaluate((i) => (i.teams[0].carTankCapacityLiters = null));
    expect(teamCheck(noTank, 'team.settings').status).toBe('FAIL');
    const override = evaluate((i) => {
      i.teams[0].carTankCapacityLiters = null;
      i.teams[0].fuelTankCapacityLiters = '90';
    });
    expect(teamCheck(override, 'team.settings').status).toBe('PASS');
  });

  it('treats 0 s pit times as set but a 0 fuel-per-lap as missing', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].refuelDurationSeconds = '0')), 'team.settings').status).toBe('PASS');
    expect(teamCheck(evaluate((i) => (i.teams[0].fuelUsagePerLapLiters = '0')), 'team.settings').status).toBe('FAIL');
  });
});

describe('team.wet-lap-time', () => {
  it('warns when missing', () => {
    expect(teamCheck(evaluate(), 'team.wet-lap-time').status).toBe('PASS');
    const failed = teamCheck(evaluate((i) => (i.teams[0].lapTimeWetSeconds = null)), 'team.wet-lap-time');
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('WARNING');
  });
});

describe('team.drivers', () => {
  it('needs the default of 4 real drivers', () => {
    expect(teamCheck(evaluate(), 'team.drivers').status).toBe('PASS');
    const failed = teamCheck(evaluate((i) => i.teams[0].members.pop()), 'team.drivers');
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('BLOCKER');
    expect(failed.detail).toContain('3 of 4');
  });

  it('respects a per-event minimum', () => {
    const result = evaluate((i) => {
      i.event.minDriversPerTeam = 3;
      i.teams[0].members.pop();
    });
    expect(result.minDriversPerTeam).toBe(3);
    expect(teamCheck(result, 'team.drivers').status).toBe('PASS');
  });

  it('counts roster guests but not free-text placeholders', () => {
    const withGuest = evaluate((i) => {
      i.teams[0].members.pop();
      i.teams[0].dummies.push({ id: 'd1', name: 'Guest', driverProfileId: 'p1', availableHours: [], profile: profile('Guest', '1004') });
    });
    expect(teamCheck(withGuest, 'team.drivers').status).toBe('PASS');
    const withPlaceholder = evaluate((i) => {
      i.teams[0].members.pop();
      i.teams[0].dummies.push({ id: 'd1', name: 'TBD', driverProfileId: null, availableHours: [], profile: null });
    });
    expect(teamCheck(withPlaceholder, 'team.drivers').status).toBe('FAIL');
  });
});

describe('team.iracing-roster', () => {
  it('passes when every driver is on the roster', () => {
    expect(teamCheck(evaluate(), 'team.iracing-roster').status).toBe('PASS');
  });

  it('fails for a driver missing from the roster and for an unlinked account', () => {
    const result = evaluate((i) => {
      i.rosters = { 500: [1001, 1002, 1003] };
      i.teams[0].members[0].profile = profile('Driver u1', '1001');
      i.teams[0].members[1].profile = { ...profile('Driver u2', '1002'), iracingCustomerId: null };
    });
    const c = teamCheck(result, 'team.iracing-roster');
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('BLOCKER');
    expect(c.detail).toContain('Driver u4 (not on the iRacing team roster)');
    expect(c.detail).toContain('Driver u2 (iRacing account not linked)');
  });

  it('is PENDING without an iRacing team or without a synced roster', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].iracingTeamId = null)), 'team.iracing-roster').status).toBe('PENDING');
    expect(teamCheck(evaluate((i) => (i.rosters = {})), 'team.iracing-roster').status).toBe('PENDING');
  });

  it('is skipped entirely on LMU events', () => {
    const result = evaluate((i) => (i.event.sim = Sim.LMU));
    expect(result.teams[0].checks.some((c) => c.id === 'team.iracing-roster')).toBe(false);
  });
});

describe('team.placeholders', () => {
  it('warns about free-text placeholders only', () => {
    expect(teamCheck(evaluate(), 'team.placeholders').status).toBe('PASS');
    const guestOnly = evaluate((i) =>
      i.teams[0].dummies.push({ id: 'd1', name: 'Guest', driverProfileId: 'p1', availableHours: [], profile: null }),
    );
    expect(teamCheck(guestOnly, 'team.placeholders').status).toBe('PASS');
    const failed = teamCheck(
      evaluate((i) => i.teams[0].dummies.push({ id: 'd2', name: 'TBD driver', driverProfileId: null, availableHours: [], profile: null })),
      'team.placeholders',
    );
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('WARNING');
    expect(failed.detail).toContain('TBD driver');
  });
});

describe('team.stints-exist and team.stint-drivers', () => {
  it('stints-exist is PENDING (not FAIL) with no stints', () => {
    expect(teamCheck(evaluate(), 'team.stints-exist').status).toBe('PASS');
    const pending = teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.stints-exist');
    expect(pending.status).toBe('PENDING');
    expect(pending.level).toBe('BLOCKER');
  });

  it('stint-drivers fails naming the driverless stints, PENDING with no stints', () => {
    expect(teamCheck(evaluate(), 'team.stint-drivers').status).toBe('PASS');
    const failed = teamCheck(
      evaluate((i) => {
        i.teams[0].stints[1].driverUserId = null;
        i.teams[0].stints[3].driverUserId = null;
      }),
      'team.stint-drivers',
    );
    expect(failed.status).toBe('FAIL');
    expect(failed.level).toBe('BLOCKER');
    expect(failed.detail).toContain('Stint 2');
    expect(failed.detail).toContain('Stint 4');
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.stint-drivers').status).toBe('PENDING');
  });
});

describe('team.plan-coverage', () => {
  it('passes within +/-5 minutes of the race length', () => {
    const c = teamCheck(evaluate(), 'team.plan-coverage');
    expect(c.status).toBe('PASS');
    expect(c.detail).toContain('4h 01m');
  });

  it('fails when the plan is short and when it is too long', () => {
    const short = teamCheck(evaluate((i) => i.teams[0].stints.pop()), 'team.plan-coverage');
    expect(short.status).toBe('FAIL');
    expect(short.level).toBe('BLOCKER');
    expect(short.detail).toContain('short');
    const long = teamCheck(evaluate((i) => i.teams[0].stints.push(stint(6, 'u2', '55'))), 'team.plan-coverage');
    expect(long.status).toBe('FAIL');
    expect(long.detail).toContain('too long');
  });

  it('is PENDING with no stints', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.plan-coverage').status).toBe('PENDING');
  });

  it('skips the tyre portion of the pit stop for a splash-and-go stint', () => {
    // 4 stops without tyres: 235 + 4 * 0.5 = 237 min -> 3 min short, still inside the tolerance
    const result = evaluate((i) => i.teams[0].stints.forEach((s) => (s.tyreChange = false)));
    expect(teamCheck(result, 'team.plan-coverage').status).toBe('PASS');
  });
});

describe('team.stint-fuel', () => {
  it('passes when every stint fits a tank', () => {
    expect(teamCheck(evaluate(), 'team.stint-fuel').status).toBe('PASS');
  });

  it('fails for a stint longer than a tank, naming stint and driver', () => {
    const c = teamCheck(evaluate((i) => (i.teams[0].stints[1].durationMinutes = '70')), 'team.stint-fuel');
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('BLOCKER');
    expect(c.detail).toContain('Stint 2 (Driver u2)');
    expect(c.detail).toContain('1h 10m planned');
  });

  it('uses the driver own fuel figure when set', () => {
    const thirsty = evaluate((i) =>
      i.teams[0].driverSettings.push({ userId: 'u2', lapTimeDrySeconds: null, lapTimeWetSeconds: null, fuelUsagePerLapLiters: '4' }),
    );
    // 100 / 4 = 25 laps * 100 s = 41.7 min < the planned 55
    expect(teamCheck(thirsty, 'team.stint-fuel').status).toBe('FAIL');
  });

  it('the first stint loses the formation lap fuel', () => {
    // 100 - 10 = 90 L / 3 = 30 laps * 100 s = 50 min < 55
    const c = teamCheck(evaluate((i) => (i.teams[0].formationLapFuelLiters = '10')), 'team.stint-fuel');
    expect(c.status).toBe('FAIL');
    expect(c.detail).toContain('Stint 1');
    expect(c.detail).not.toContain('Stint 2');
  });

  it('applies the iRacing fuel limit percent to the tank', () => {
    // 100 L * 90% = 90 L -> 30 laps -> 50 min < 55
    expect(teamCheck(evaluate((i) => (i.event.fuelLimitPercent = '90')), 'team.stint-fuel').status).toBe('FAIL');
  });

  it('is PENDING without stints or without the fuel inputs', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.stint-fuel').status).toBe('PENDING');
    expect(teamCheck(evaluate((i) => (i.teams[0].fuelUsagePerLapLiters = null)), 'team.stint-fuel').status).toBe('PENDING');
  });
});

describe('team.availability', () => {
  const at = (hoursFromStart: number) => new Date(START.getTime() + hoursFromStart * HOUR);

  it('unrestricted drivers (no marked hours) are fine', () => {
    expect(teamCheck(evaluate(), 'team.availability').status).toBe('PASS');
  });

  it('warns when a stint runs into an unmarked hour', () => {
    // u2 drives 12:56-13:51 but only marked 12:00
    const c = teamCheck(
      evaluate((i) => (i.teams[0].members[1].availableHours = [at(0)])),
      'team.availability',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('WARNING');
    expect(c.detail).toContain('Stint 2 (Driver u2)');
    expect(c.fix?.kind).toBe('team-availability');
  });

  it('passes when every hour the stint touches is marked', () => {
    const result = evaluate((i) => (i.teams[0].members[1].availableHours = [at(0), at(1)]));
    expect(teamCheck(result, 'team.availability').status).toBe('PASS');
  });

  it('is PENDING without a start time or stints', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].timeslotId = null)), 'team.availability').status).toBe('PENDING');
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.availability').status).toBe('PENDING');
  });
});

describe('team.successive-stints', () => {
  it('warns when a driver exceeds their maximum in a row', () => {
    const c = teamCheck(
      evaluate((i) => {
        i.teams[0].members[0].profile = profile('Driver u1', '1001', { maxSuccessiveStints: 1 });
        i.teams[0].stints[1].driverUserId = 'u1';
      }),
      'team.successive-stints',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('WARNING');
    expect(c.detail).toContain('Driver u1: 2 in a row (max 1)');
  });

  it('passes when within limits (or no limit set) and is PENDING with no stints', () => {
    expect(teamCheck(evaluate(), 'team.successive-stints').status).toBe('PASS');
    const ok = evaluate((i) => (i.teams[0].members[0].profile = profile('Driver u1', '1001', { maxSuccessiveStints: 1 })));
    expect(teamCheck(ok, 'team.successive-stints').status).toBe('PASS');
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.successive-stints').status).toBe('PENDING');
  });
});

describe('LMU tyre limit', () => {
  function lmu(limit: number, tyresPerStop: number, stops = 4): ReadinessResult {
    return evaluate((i) => {
      i.event.sim = Sim.LMU;
      i.event.tyreLimit = limit;
      i.teams[0].stints.forEach((s, idx) => {
        s.tyresChanged = tyresPerStop;
        s.tyreChange = tyresPerStop > 0;
        if (idx > stops) s.tyresChanged = 0;
      });
    });
  }

  it('is absent without a limit and on iRacing', () => {
    expect(evaluate().teams[0].checks.some((c) => c.id.startsWith('team.tyre-limit'))).toBe(false);
    const lmuNoLimit = evaluate((i) => (i.event.sim = Sim.LMU));
    expect(lmuNoLimit.teams[0].checks.some((c) => c.id.startsWith('team.tyre-limit'))).toBe(false);
  });

  it('passes comfortably under the limit', () => {
    const r = lmu(40, 2); // 4 + 4*2 = 12 of 40
    expect(teamCheck(r, 'team.tyre-limit').status).toBe('PASS');
    expect(teamCheck(r, 'team.tyre-limit-near').status).toBe('PASS');
  });

  it('warns at 90% or more of the budget', () => {
    const r = lmu(20, 4); // 4 + 16 = 20 of 20
    expect(teamCheck(r, 'team.tyre-limit').status).toBe('PASS');
    const near = teamCheck(r, 'team.tyre-limit-near');
    expect(near.status).toBe('FAIL');
    expect(near.level).toBe('WARNING');
    expect(teamCheck(lmu(22, 4), 'team.tyre-limit-near').status).toBe('FAIL'); // 20 / 22 = 91%
    expect(teamCheck(lmu(23, 4), 'team.tyre-limit-near').status).toBe('PASS'); // 87%
  });

  it('blocks when over the limit, without double-reporting the warning', () => {
    const r = lmu(15, 4);
    const over = teamCheck(r, 'team.tyre-limit');
    expect(over.status).toBe('FAIL');
    expect(over.level).toBe('BLOCKER');
    expect(over.detail).toContain('5 over');
    expect(teamCheck(r, 'team.tyre-limit-near').status).toBe('PASS');
  });

  it('is PENDING with no stints', () => {
    const r = evaluate((i) => {
      i.event.sim = Sim.LMU;
      i.event.tyreLimit = 20;
      i.teams[0].stints = [];
    });
    expect(teamCheck(r, 'team.tyre-limit').status).toBe('PENDING');
    expect(teamCheck(r, 'team.tyre-limit-near').status).toBe('PENDING');
  });
});

describe('team.night-drivers', () => {
  const darkAtStint3 = {
    state: 'OK' as const,
    // stint 3 starts 113 min after the green flag -> nearest point is the one at 120
    points: [{ time_offset: 0, is_sun_up: true }, { time_offset: 120, is_sun_up: false }, { time_offset: 300, is_sun_up: true }],
  };

  it('warns when a non-night driver drives in the dark', () => {
    const c = teamCheck(
      evaluate((i) => {
        i.forecast = darkAtStint3;
        i.teams[0].members[2].profile = profile('Driver u3', '1003', { nightDriver: false });
      }),
      'team.night-drivers',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('WARNING');
    expect(c.detail).toContain('Stint 3 (Driver u3)');
  });

  it('passes for night drivers in the dark and for non-night drivers in daylight', () => {
    expect(teamCheck(evaluate((i) => (i.forecast = darkAtStint3)), 'team.night-drivers').status).toBe('PASS');
    const day = evaluate((i) => (i.teams[0].members[2].profile = profile('Driver u3', '1003', { nightDriver: false })));
    expect(teamCheck(day, 'team.night-drivers').status).toBe('PASS');
  });

  it('is PENDING with the reason when the forecast is unavailable', () => {
    const c = teamCheck(evaluate((i) => (i.forecast = { state: 'UNAVAILABLE', reason: 'link expired' })), 'team.night-drivers');
    expect(c.status).toBe('PENDING');
    expect(c.detail).toContain('link expired');
  });

  it('is PENDING without stints or a start time, and absent when not linked or on LMU', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.night-drivers').status).toBe('PENDING');
    expect(teamCheck(evaluate((i) => (i.teams[0].timeslotId = null)), 'team.night-drivers').status).toBe('PENDING');
    const unlinked = evaluate((i) => (i.forecast = null));
    expect(unlinked.teams[0].checks.some((c) => c.id === 'team.night-drivers')).toBe(false);
    const lmu = evaluate((i) => (i.event.sim = Sim.LMU));
    expect(lmu.teams[0].checks.some((c) => c.id === 'team.night-drivers')).toBe(false);
  });
});

describe('team.starting-driver', () => {
  it('passes when the first stint driver is a starting driver', () => {
    expect(teamCheck(evaluate(), 'team.starting-driver').status).toBe('PASS');
  });

  it('is an INFO failure otherwise', () => {
    const c = teamCheck(evaluate((i) => (i.teams[0].stints[0].driverUserId = 'u2')), 'team.starting-driver');
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('INFO');
  });

  it('is PENDING with no stints, no first driver, or a driver without a profile', () => {
    expect(teamCheck(evaluate((i) => (i.teams[0].stints = [])), 'team.starting-driver').status).toBe('PENDING');
    expect(teamCheck(evaluate((i) => (i.teams[0].stints[0].driverUserId = null)), 'team.starting-driver').status).toBe('PENDING');
    const noProfile = evaluate((i) => (i.teams[0].members[0].profile = null));
    expect(teamCheck(noProfile, 'team.starting-driver').status).toBe('PENDING');
  });
});

describe('event.teams-exist and the checks that need teams', () => {
  it('with no teams: teams-exist and team-dependent checks are PENDING, summary PENDING', () => {
    const result = evaluate((i) => {
      i.teams = [];
      i.signups = [];
    });
    expect(eventCheck(result, 'event.teams-exist')).toMatchObject({ status: 'PENDING', level: 'BLOCKER', detail: 'No teams yet.' });
    expect(eventCheck(result, 'event.unplaced-drivers').status).toBe('PENDING');
    expect(eventCheck(result, 'event.unplaced-guests').status).toBe('PENDING');
    expect(result.summary.status).toBe('PENDING');
    expect(result.teams).toEqual([]);
  });

  it('passes with a team', () => {
    expect(eventCheck(evaluate(), 'event.teams-exist').status).toBe('PASS');
  });
});

describe('event.unplaced-drivers', () => {
  it('warns about confirmed signups not on any team', () => {
    const c = eventCheck(
      evaluate((i) => i.signups.push({ userId: 'u9', name: 'Late Larry', status: 'CONFIRMED', eventTeamId: null })),
      'event.unplaced-drivers',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('WARNING');
    expect(c.detail).toContain('Late Larry');
    expect(c.fix?.kind).toBe('team-building');
  });

  it('ignores waitlisted and cancelled signups', () => {
    const result = evaluate((i) => {
      i.signups.push({ userId: 'u8', name: 'Waiting', status: 'WAITLISTED', eventTeamId: null });
      i.signups.push({ userId: 'u9', name: 'Gone', status: 'CANCELLED', eventTeamId: null });
    });
    expect(eventCheck(result, 'event.unplaced-drivers').status).toBe('PASS');
  });
});

describe('event.waitlisted', () => {
  it('is an INFO failure when someone is waitlisted', () => {
    expect(eventCheck(evaluate(), 'event.waitlisted').status).toBe('PASS');
    const c = eventCheck(
      evaluate((i) => i.signups.push({ userId: 'u8', name: 'Waiting Wendy', status: 'WAITLISTED', eventTeamId: null })),
      'event.waitlisted',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('INFO');
    expect(c.detail).toContain('Waiting Wendy');
    expect(c.fix?.kind).toBe('signups');
  });
});

describe('event.unplaced-guests', () => {
  it('warns about guest signups that are on no team, passes once placed', () => {
    const unplaced = eventCheck(
      evaluate((i) => i.guestSignups.push({ driverProfileId: 'p1', name: 'Guest Gus' })),
      'event.unplaced-guests',
    );
    expect(unplaced.status).toBe('FAIL');
    expect(unplaced.level).toBe('WARNING');
    expect(unplaced.detail).toContain('Guest Gus');
    const placed = evaluate((i) => {
      i.guestSignups.push({ driverProfileId: 'p1', name: 'Guest Gus' });
      i.teams[0].dummies.push({ id: 'd1', name: 'Guest Gus', driverProfileId: 'p1', availableHours: [], profile: null });
    });
    expect(eventCheck(placed, 'event.unplaced-guests').status).toBe('PASS');
  });
});

describe('event.forecast-linked', () => {
  it('INFO when an iRacing event is not linked to a week; absent on LMU', () => {
    expect(eventCheck(evaluate(), 'event.forecast-linked').status).toBe('PASS');
    const c = eventCheck(
      evaluate((i) => {
        i.event.iracingSeasonId = null;
        i.event.iracingRaceWeekNum = null;
      }),
      'event.forecast-linked',
    );
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('INFO');
    expect(c.fix?.kind).toBe('event-edit');
    expect(evaluate((i) => (i.event.sim = Sim.LMU)).event.some((x) => x.id === 'event.forecast-linked')).toBe(false);
  });
});

describe('event.driver-clash', () => {
  function twoTeams(clash: boolean): ReadinessResult {
    return evaluate((i) => {
      const second = goodTeam('t2', 'Team Two');
      second.members = [member('u5', '1005'), member('u6', '1006'), member('u7', '1007'), member('u8', '1008')];
      second.stints = [stint(1, clash ? 'u1' : 'u5', '55'), stint(2, 'u6', '55'), stint(3, 'u7', '55'), stint(4, 'u8', '55'), stint(5, 'u5', '15')];
      i.teams.push(second);
      i.rosters[500] = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008];
      i.driverNames = { ...i.driverNames, u5: 'Driver u5' };
    });
  }

  it('fails when one driver is on two teams at overlapping times, listing the clash', () => {
    const c = eventCheck(twoTeams(true), 'event.driver-clash');
    expect(c.status).toBe('FAIL');
    expect(c.level).toBe('BLOCKER');
    expect(c.detail).toContain('Driver u1');
    expect(c.detail).toContain('Team One stint 1');
    expect(c.detail).toContain('Team Two stint 1');
  });

  it('passes when drivers are different or the stints do not overlap', () => {
    expect(eventCheck(twoTeams(false), 'event.driver-clash').status).toBe('PASS');
    const staggered = evaluate((i) => {
      const second = goodTeam('t2', 'Team Two');
      i.timeslots.push({ id: 'ts2', startsAt: new Date(START.getTime() + 24 * HOUR) });
      second.timeslotId = 'ts2';
      i.teams.push(second); // same drivers, a day later
    });
    expect(eventCheck(staggered, 'event.driver-clash').status).toBe('PASS');
  });

  it('is PENDING when no team has timed stints yet', () => {
    expect(eventCheck(evaluate((i) => (i.teams[0].stints = [])), 'event.driver-clash').status).toBe('PENDING');
    expect(eventCheck(evaluate((i) => (i.teams[0].timeslotId = null)), 'event.driver-clash').status).toBe('PENDING');
  });
});

describe('summarizeChecks', () => {
  const c = (level: ReadinessCheck['level'], status: ReadinessCheck['status']): ReadinessCheck => ({
    id: 'x',
    level,
    status,
    title: 'x',
  });

  it('counts failed checks by level, plus pending and passed', () => {
    const s = summarizeChecks(
      [c('BLOCKER', 'FAIL'), c('BLOCKER', 'PENDING'), c('WARNING', 'FAIL'), c('WARNING', 'FAIL'), c('INFO', 'FAIL'), c('INFO', 'PASS'), c('BLOCKER', 'PASS')],
      true,
    );
    expect(s).toEqual({ blockers: 1, warnings: 2, infos: 1, pending: 1, passed: 2, status: 'BLOCKED' });
  });

  it('BLOCKED beats WARNINGS beats PENDING beats READY', () => {
    expect(summarizeChecks([c('BLOCKER', 'FAIL'), c('WARNING', 'FAIL')], true).status).toBe('BLOCKED');
    expect(summarizeChecks([c('WARNING', 'FAIL')], true).status).toBe('WARNINGS');
    // A blocker-level check that can't be evaluated yet (e.g. no stints) means "not set up yet"…
    expect(summarizeChecks([c('BLOCKER', 'PENDING')], true).status).toBe('PENDING');
    // …but a pending warning/info (e.g. an unavailable forecast) never holds READY back.
    expect(summarizeChecks([c('WARNING', 'PENDING'), c('INFO', 'PENDING')], true).status).toBe('READY');
    expect(summarizeChecks([c('BLOCKER', 'PASS')], false).status).toBe('PENDING');
    expect(summarizeChecks([c('BLOCKER', 'PASS')], true).status).toBe('READY');
  });

  it('an INFO failure alone does not change READY', () => {
    expect(summarizeChecks([c('INFO', 'FAIL')], true)).toMatchObject({ infos: 1, status: 'READY' });
  });

  it('a blocker anywhere makes the overall summary BLOCKED while the other team stays READY', () => {
    const result = evaluate((i) => {
      i.teams.push({ ...goodTeam('t2', 'Team Two'), carId: null });
      i.signups.push({ userId: 'x', name: 'x', status: 'CONFIRMED', eventTeamId: 't2' });
    });
    expect(result.teams[0].summary.status).toBe('READY');
    expect(result.teams[1].summary.status).toBe('BLOCKED');
    expect(result.summary.status).toBe('BLOCKED');
  });
});

describe('restrictReadinessToTeams', () => {
  it('keeps only the given teams, drops event checks, and recomputes the summary from those teams', () => {
    const full = evaluate((i) => {
      i.teams.push({ ...goodTeam('t2', 'Team Two'), carId: null });
    });
    expect(full.summary.status).toBe('BLOCKED');
    const mine = restrictReadinessToTeams(full, new Set(['t1']));
    expect(mine.event).toEqual([]);
    expect(mine.teams.map((t) => t.teamId)).toEqual(['t1']);
    expect(mine.summary.status).toBe('READY');
    expect(mine.summary.blockers).toBe(0);
    expect(mine.eventId).toBe('e1');
    expect(mine.minDriversPerTeam).toBe(4);
  });

  it('a member on no team gets an empty, PENDING result', () => {
    const none = restrictReadinessToTeams(evaluate(), new Set());
    expect(none.teams).toEqual([]);
    expect(none.event).toEqual([]);
    expect(none.summary.status).toBe('PENDING');
  });
});
