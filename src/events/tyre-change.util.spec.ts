import { describe, expect, it } from 'vitest';
import {
  PARTIAL_TYRE_CHANGE_SECONDS_DEFAULT,
  reconcileTyreFields,
  resolveTyresChanged,
  tyreStopSeconds,
} from './tyre-change.util.js';

describe('tyreStopSeconds', () => {
  const team: { tyreChangeDurationSeconds: string; partialTyreChangeSeconds: string | null } = {
    tyreChangeDurationSeconds: '120',
    partialTyreChangeSeconds: null,
  };
  const lmu = (tyresChanged: number | null, tyreChange = true, t = team) =>
    tyreStopSeconds({ tyresChanged, tyreChange }, t, 'LMU');

  it('keeps the default at 5 seconds', () => {
    expect(PARTIAL_TYRE_CHANGE_SECONDS_DEFAULT).toBe(5);
  });

  it('LMU: 0 tyres cost nothing, 1-2 the partial time, 3-4 the full time', () => {
    expect(lmu(0)).toBe(0);
    expect(lmu(1)).toBe(5);
    expect(lmu(2)).toBe(5);
    expect(lmu(3)).toBe(120);
    expect(lmu(4)).toBe(120);
  });

  it('LMU: uses the team partial setting over the fallback, including 0', () => {
    expect(lmu(2, true, { ...team, partialTyreChangeSeconds: '8.50' })).toBe(8.5);
    expect(lmu(1, true, { ...team, partialTyreChangeSeconds: '0.00' })).toBe(0);
  });

  it('LMU: derives legacy null counts from the boolean', () => {
    expect(lmu(null, true)).toBe(120);
    expect(lmu(null, false)).toBe(0);
  });

  it('iRacing / unknown sim: boolean rule with the full time, partial setting ignored', () => {
    const withPartial = { ...team, partialTyreChangeSeconds: '8' };
    expect(tyreStopSeconds({ tyresChanged: 1, tyreChange: true }, withPartial, 'IRACING')).toBe(120);
    expect(tyreStopSeconds({ tyresChanged: 0, tyreChange: false }, withPartial, 'IRACING')).toBe(0);
    expect(tyreStopSeconds({ tyreChange: true }, withPartial, undefined)).toBe(120);
  });
});

describe('resolveTyresChanged', () => {
  it('uses the stored count when present, including 0', () => {
    expect(resolveTyresChanged({ tyresChanged: 2, tyreChange: true })).toBe(2);
    expect(resolveTyresChanged({ tyresChanged: 0, tyreChange: true })).toBe(0);
  });

  it('derives from the legacy boolean when the count is null', () => {
    expect(resolveTyresChanged({ tyresChanged: null, tyreChange: true })).toBe(4);
    expect(resolveTyresChanged({ tyresChanged: null, tyreChange: false })).toBe(0);
  });
});

describe('reconcileTyreFields', () => {
  const current = { tyresChanged: 2, tyreChange: true };

  it('returns null when neither field is given', () => {
    expect(reconcileTyreFields({}, current)).toBeNull();
  });

  it('syncs the boolean from an explicit count', () => {
    expect(reconcileTyreFields({ tyresChanged: 0 }, current)).toEqual({ tyresChanged: 0, tyreChange: false });
    expect(reconcileTyreFields({ tyresChanged: 3 }, { tyresChanged: 0, tyreChange: false })).toEqual({
      tyresChanged: 3,
      tyreChange: true,
    });
  });

  it('lets an explicit count win over a conflicting boolean', () => {
    expect(reconcileTyreFields({ tyresChanged: 1, tyreChange: false }, current)).toEqual({
      tyresChanged: 1,
      tyreChange: true,
    });
  });

  it('keeps the existing count for a bare boolean that agrees with it', () => {
    expect(reconcileTyreFields({ tyreChange: true }, current)).toEqual({ tyresChanged: 2, tyreChange: true });
  });

  it('moves the count for a bare boolean that contradicts it', () => {
    expect(reconcileTyreFields({ tyreChange: false }, current)).toEqual({ tyresChanged: 0, tyreChange: false });
    expect(reconcileTyreFields({ tyreChange: true }, { tyresChanged: 0, tyreChange: false })).toEqual({
      tyresChanged: 4,
      tyreChange: true,
    });
  });

  it('treats a legacy null count via the stored boolean', () => {
    expect(reconcileTyreFields({ tyreChange: true }, { tyresChanged: null, tyreChange: true })).toEqual({
      tyresChanged: 4,
      tyreChange: true,
    });
    expect(reconcileTyreFields({ tyreChange: false }, { tyresChanged: null, tyreChange: true })).toEqual({
      tyresChanged: 0,
      tyreChange: false,
    });
  });
});
