import { describe, expect, it } from 'vitest';
import { buildRaceSummaryText, formatDriveMs, formatLapTimeMs, type SummaryStintInput } from './race-summary-text.js';

const stint = (over: Partial<SummaryStintInput> & { driverProfileId: string }): SummaryStintInput => ({
  averageLapTimeMs: 100_000,
  bestLapTimeMs: 98_000,
  incidents: 0,
  lapsComplete: 20,
  ...over,
});

const result = (stints: SummaryStintInput[]) => ({
  id: 'res-1',
  trackName: 'Daytona',
  trackConfig: 'Road',
  seriesName: 'IMSA',
  startTime: new Date('2026-10-24T12:00:00Z'),
  driverStints: stints,
});

const URL = 'https://app.example/results/res-1';

describe('formatters', () => {
  it('formats lap times and drive durations', () => {
    expect(formatLapTimeMs(92_456)).toBe('1:32.456');
    expect(formatLapTimeMs(58_123)).toBe('58.123');
    expect(formatDriveMs(72 * 60_000)).toBe('1h 12m');
    expect(formatDriveMs(38 * 60_000)).toBe('38m');
    expect(formatDriveMs(30_000)).toBe('<1m');
  });
});

describe('buildRaceSummaryText', () => {
  const team = [
    stint({ driverProfileId: 'a', lapsComplete: 20, averageLapTimeMs: 100_000, bestLapTimeMs: 98_000, incidents: 1 }),
    stint({ driverProfileId: 'b', lapsComplete: 40, averageLapTimeMs: 101_000, bestLapTimeMs: 99_000, incidents: 3 }),
    stint({ driverProfileId: 'c', lapsComplete: 20, averageLapTimeMs: 103_000, bestLapTimeMs: 97_500, incidents: 0 }),
  ];

  it('returns null when the driver has no stint in the result', () => {
    expect(buildRaceSummaryText(result(team), 'zzz', URL)).toBeNull();
  });

  it('builds laps, share, drive time, pace vs team, best-lap rank, incidents and the link', () => {
    const text = buildRaceSummaryText(result(team), 'a', URL) as string;
    expect(text).toContain('**Your race: Daytona - Road**');
    expect(text).toContain('(IMSA, 24 Oct 2026)');
    // 20 of 80 laps = 25%; 100 000 ms x 20 laps = 33m 20s -> "33m".
    expect(text).toContain("**Laps:** 20 (25% of the team's laps) · **Drive time:** 33m");
    // Team average (lap-weighted) = 101 250 ms; driver 100 000 -> 1.25s faster.
    expect(text).toContain('**Average lap:** 1:40.000 - 1.25s faster than the team average');
    expect(text).toContain('**Best lap:** 1:38.000 (2nd of 3)');
    expect(text).toContain('**Incidents:** 1x');
    expect(text).toContain(`<${URL}>`);
  });

  it('says "fastest of N" for the quickest best lap and "slower" for a slower average', () => {
    const text = buildRaceSummaryText(result(team), 'c', URL) as string;
    expect(text).toContain('(fastest of 3)');
    expect(text).toContain('1.75s slower than the team average');
    expect(text).toContain('**Incidents:** 0x');
  });

  it('skips the pace comparison and rank for a lone driver and leaves out missing data', () => {
    const text = buildRaceSummaryText(
      result([
        stint({ driverProfileId: 'a', averageLapTimeMs: null, bestLapTimeMs: null, incidents: null, lapsComplete: null }),
      ]),
      'a',
      URL,
    ) as string;
    expect(text).not.toContain('Laps:');
    expect(text).not.toContain('Average lap');
    expect(text).not.toContain('Best lap');
    expect(text).not.toContain('Incidents');
    expect(text).toContain(URL);

    const solo = buildRaceSummaryText(result([team[0]]), 'a', URL) as string;
    expect(solo).not.toContain('team average');
    expect(solo).not.toContain('of 1)');
    expect(solo).toContain("100% of the team's laps");
  });

  it('omits the track config and context when absent', () => {
    const text = buildRaceSummaryText(
      { ...result(team), trackConfig: null, seriesName: null, startTime: null },
      'a',
      URL,
    ) as string;
    expect(text.split('\n')[0]).toBe('\u{1F3C1} **Your race: Daytona**');
  });
});
