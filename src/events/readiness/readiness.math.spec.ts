import { describe, expect, it } from 'vitest';
import {
  effectiveTankLiters,
  formatMinutes,
  longestRunsByDriver,
  maxStintMinutes,
  overlappingRaceHours,
  parseDecimal,
  tyresChangedOf,
  tyresUsed,
  usableTankForStint,
} from './readiness.math.js';

describe('maxStintMinutes (parity with EventTeamPlanPage)', () => {
  it('floors the laps a tank lasts, then multiplies by the lap time', () => {
    // 100 L / 3.5 L = 28.57 -> 28 laps; 28 * 95 s = 2660 s = 44.333 min
    expect(maxStintMinutes(100, 3.5, 95)).toBeCloseTo(44.3333, 4);
    // 98 L (100 L at a 98% limit) / 3.0 = 32.67 -> 32 laps; 32 * 100 s = 53.333 min
    expect(maxStintMinutes(98, 3, 100)).toBeCloseTo(53.3333, 4);
    // exact division keeps every lap: 90 L / 3 = 30 laps; 30 * 120 s = 60 min
    expect(maxStintMinutes(90, 3, 120)).toBe(60);
  });

  it('is null when tank, fuel per lap (> 0) or lap time is missing or zero', () => {
    expect(maxStintMinutes(null, 3, 100)).toBeNull();
    expect(maxStintMinutes(100, null, 100)).toBeNull();
    expect(maxStintMinutes(100, 0, 100)).toBeNull();
    expect(maxStintMinutes(100, 3, null)).toBeNull();
    expect(maxStintMinutes(100, 3, 0)).toBeNull();
    expect(maxStintMinutes(0, 3, 100)).toBeNull();
  });

  it('is 0 minutes (not null) when a tank holds less than one lap', () => {
    expect(maxStintMinutes(2, 3, 100)).toBe(0);
  });
});

describe('effectiveTankLiters', () => {
  it('prefers the team override over the car tank', () => {
    expect(effectiveTankLiters(80, 100, null, true)).toBe(80);
    expect(effectiveTankLiters(null, 100, null, true)).toBe(100);
  });

  it('applies the fuel-limit percent on iRacing only', () => {
    expect(effectiveTankLiters(null, 100, 98, true)).toBe(98);
    expect(effectiveTankLiters(null, 100, 98, false)).toBe(100);
  });

  it('is null with no tank source', () => {
    expect(effectiveTankLiters(null, null, 98, true)).toBeNull();
  });
});

describe('usableTankForStint', () => {
  it('subtracts the formation lap fuel from the first stint only, never below 0', () => {
    expect(usableTankForStint(100, 2.5, true)).toBe(97.5);
    expect(usableTankForStint(100, 2.5, false)).toBe(100);
    expect(usableTankForStint(1, 2.5, true)).toBe(0);
    expect(usableTankForStint(null, 2.5, true)).toBeNull();
  });
});

describe('overlappingRaceHours', () => {
  const start = Date.parse('2026-10-24T12:00:00Z');
  const h = (n: number) => start + n * 3_600_000;

  it('lists every hour bucket a window touches, anchored at the timeslot start', () => {
    expect(overlappingRaceHours(start, h(0), h(1))).toEqual([h(0)]);
    expect(overlappingRaceHours(start, start + 56 * 60_000, start + 111 * 60_000)).toEqual([h(0), h(1)]);
  });

  it('a window ending exactly on the hour does not touch the next hour', () => {
    expect(overlappingRaceHours(start, h(1), h(2))).toEqual([h(1)]);
  });

  it('clamps windows that start before the timeslot', () => {
    expect(overlappingRaceHours(start, h(-2), h(1))).toEqual([h(0)]);
  });
});

describe('tyresUsed (parity with portal lib/tyres.ts)', () => {
  it('counts the 4 starting tyres plus later stints and ignores the first stint value', () => {
    const stints = [
      { tyreChange: true, tyresChanged: 4 },
      { tyreChange: true, tyresChanged: 2 },
      { tyreChange: true, tyresChanged: 4 },
    ];
    expect(tyresUsed(stints)).toBe(10);
  });

  it('an empty plan still uses the starting set', () => {
    expect(tyresUsed([])).toBe(4);
  });

  it('derives legacy null rows from the boolean and clamps to 0-4', () => {
    expect(tyresChangedOf({ tyreChange: true, tyresChanged: null })).toBe(4);
    expect(tyresChangedOf({ tyreChange: false, tyresChanged: null })).toBe(0);
    expect(tyresChangedOf({ tyreChange: true, tyresChanged: 9 })).toBe(4);
    expect(tyresChangedOf({ tyreChange: true, tyresChanged: -1 })).toBe(0);
  });
});

describe('longestRunsByDriver', () => {
  it('finds each driver longest run of consecutive stints; unassigned breaks a run', () => {
    const runs = longestRunsByDriver(['a', 'a', 'b', 'a', null, 'a', 'a', 'a']);
    expect(runs.get('a')).toBe(3);
    expect(runs.get('b')).toBe(1);
    expect(runs.size).toBe(2);
  });
});

describe('small helpers', () => {
  it('parseDecimal reads strings and rejects junk', () => {
    expect(parseDecimal('12.50')).toBe(12.5);
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('0')).toBe(0);
  });

  it('formatMinutes rounds first so it never prints 60m', () => {
    expect(formatMinutes(119.6)).toBe('2h 00m');
    expect(formatMinutes(42)).toBe('42m');
    expect(formatMinutes(185)).toBe('3h 05m');
  });
});
