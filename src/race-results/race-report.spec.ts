import 'reflect-metadata';
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { ROLES_KEY } from '../common/decorators/roles.decorator.js';
import { RaceReportController } from './race-report.controller.js';
import { RaceReportService } from './race-report.service.js';
import { DISCORD_LIMIT, type ReportResultInput, SHORT_LIMIT, buildRaceReport, reportFacts } from './race-report.js';

const base: ReportResultInput = {
  seriesName: 'IMSA_Endurance',
  trackName: 'Daytona',
  trackConfig: 'Road Course',
  carName: 'BMW M4 GT3',
  teamName: 'W2W Red',
  startTime: new Date('2026-10-24T12:00:00Z'),
  endTime: new Date('2026-10-24T14:00:00Z'),
  startingPosition: 12,
  finishingPosition: 7,
  startingPositionInClass: 9,
  finishingPositionInClass: 3,
  teamLapsComplete: 120,
  teamIncidents: 4,
  driverStints: [
    { displayName: 'Anna', averageLapTimeMs: 90_000, bestLapTimeMs: 88_500, incidents: 2, lapsComplete: 40 },
    { displayName: 'Ben', averageLapTimeMs: 91_000, bestLapTimeMs: 87_123, incidents: 2, lapsComplete: 50 },
    { displayName: 'Chloe', averageLapTimeMs: 92_000, bestLapTimeMs: 89_900, incidents: 0, lapsComplete: 30 },
  ],
};

describe('reportFacts', () => {
  it('tells the place in class when there is one, and the places gained from the start in that same scope', () => {
    const facts = reportFacts(base);
    expect(facts.placeText).toBe('P3 in class (P7 overall)');
    expect(facts.place).toBe(3);
    expect(facts.placesGained).toBe(6); // class P9 -> P3
    expect(facts.title).toBe('IMSA_Endurance · Daytona - Road Course');
    expect(facts.date).toBe('24 Oct 2026');
  });

  it('falls back to overall positions without a class', () => {
    const facts = reportFacts({ ...base, finishingPositionInClass: null, startingPositionInClass: null });
    expect(facts.placeText).toBe('P7 overall');
    expect(facts.placesGained).toBe(5); // overall P12 -> P7
  });

  it('does not invent a start comparison when the start is unknown', () => {
    const facts = reportFacts({ ...base, startingPositionInClass: null });
    expect(facts.placesGained).toBeNull();
    expect(facts.startText).toBeNull();
  });

  it('works out the drivers, the most driven, the fastest lap and the cleanest drive', () => {
    const facts = reportFacts(base);
    // drive time = average lap x laps: Anna 60 min, Ben 75.8 min, Chloe 46 min
    expect(facts.drivers.map((d) => d.name)).toEqual(['Ben', 'Anna', 'Chloe']);
    expect(facts.mostDriven).toEqual({ name: 'Ben', driveMs: 4_550_000 });
    expect(facts.fastestLap).toEqual({ name: 'Ben', ms: 87_123 });
    expect(facts.cleanest).toEqual({ name: 'Chloe', incidents: 0, laps: 30 });
  });

  it('needs a comparison for the cleanest drive and enough laps for it to count', () => {
    const solo = reportFacts({ ...base, driverStints: [base.driverStints[0]] });
    expect(solo.cleanest).toBeNull();
    expect(solo.mostDriven).toBeNull();
    const shortStint = reportFacts({
      ...base,
      driverStints: [
        { displayName: 'A', averageLapTimeMs: 90_000, bestLapTimeMs: null, incidents: 0, lapsComplete: 5 },
        { displayName: 'B', averageLapTimeMs: 90_000, bestLapTimeMs: null, incidents: 3, lapsComplete: 40 },
      ],
    });
    expect(shortStint.cleanest).toBeNull(); // only one driver has 20+ laps
  });

  it('breaks a tie on incident rate by the longer drive', () => {
    const facts = reportFacts({
      ...base,
      driverStints: [
        { displayName: 'Short', averageLapTimeMs: 90_000, bestLapTimeMs: null, incidents: 0, lapsComplete: 25 },
        { displayName: 'Long', averageLapTimeMs: 90_000, bestLapTimeMs: null, incidents: 0, lapsComplete: 60 },
        { displayName: 'Messy', averageLapTimeMs: 90_000, bestLapTimeMs: null, incidents: 4, lapsComplete: 40 },
      ],
    });
    expect(facts.cleanest?.name).toBe('Long');
  });
});

describe('buildRaceReport', () => {
  it('writes the Discord post: headline, finish, numbers, drivers, fastest lap and cleanest drive', () => {
    const { discord } = buildRaceReport(base, 'https://portal.test/share/results/tok');
    expect(discord.split('\n')).toEqual([
      '🥉 **IMSA\\_Endurance · Daytona - Road Course** · 24 Oct 2026',
      'W2W Red · BMW M4 GT3',
      'We finished **P3 in class (P7 overall)**, from P9, up 6 places.',
      '120 laps with 4 incidents.',
      'Driven by Ben, Anna and Chloe. Most time in the car: Ben (1h 16m).',
      '⚡ Fastest lap: Ben, 1:27.123',
      '🧼 Cleanest drive: Chloe, 0 incidents in 30 laps',
      'https://portal.test/share/results/tok',
    ]);
  });

  it('uses a trophy for a win and calls a spotless race a clean race', () => {
    const { discord } = buildRaceReport({ ...base, finishingPositionInClass: 1, teamIncidents: 0 }, null);
    expect(discord).toContain('🏆');
    expect(discord).toContain('120 laps with a clean race: no incidents.');
    expect(discord).not.toContain('https://');
  });

  it('says down N places and holding the place, and escapes markdown in names', () => {
    const down = buildRaceReport({ ...base, startingPositionInClass: 2 }, null).discord;
    expect(down).toContain('from P2, down 1 place.');
    const held = buildRaceReport({ ...base, startingPositionInClass: 3 }, null).discord;
    expect(held).toContain('from P3, holding the place.');
    const named = buildRaceReport(
      { ...base, driverStints: [{ ...base.driverStints[0], displayName: 'A_*B' }, base.driverStints[1]] },
      null,
    ).discord;
    expect(named).toContain('A\\_\\*B');
  });

  it('leaves out every line whose data is missing and never throws on an almost empty result', () => {
    const { discord, short } = buildRaceReport(
      {
        seriesName: null,
        trackName: 'Spa',
        trackConfig: null,
        carName: null,
        startTime: null,
        endTime: null,
        startingPosition: null,
        finishingPosition: null,
        startingPositionInClass: null,
        finishingPositionInClass: null,
        teamLapsComplete: null,
        teamIncidents: null,
        driverStints: [],
      },
      null,
    );
    expect(discord).toBe('🏁 **Spa**');
    expect(short).toBe('🏁 Spa:');
  });

  it('writes a short post that fits a social post, dropping details before the link', () => {
    const url = 'https://portal.test/share/results/tok';
    const { short } = buildRaceReport(base, url);
    expect(short).toBe(
      '🥉 IMSA_Endurance at Daytona: P3 in class (P7 overall) from P9, up 6 places. 120 laps, 3 drivers. Fastest lap 1:27.123 (Ben). https://portal.test/share/results/tok',
    );
    const longName = buildRaceReport(
      { ...base, driverStints: [{ ...base.driverStints[0], displayName: 'X'.repeat(300), bestLapTimeMs: 80_000 }] },
      url,
    ).short;
    expect(longName.length).toBeLessThanOrEqual(SHORT_LIMIT);
    expect(longName.endsWith(url)).toBe(true);
  });

  it('keeps the Discord text within 2000 characters', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...base.driverStints[0], displayName: `Driver number ${i}` }));
    expect(buildRaceReport({ ...base, driverStints: many }, null).discord.length).toBeLessThanOrEqual(DISCORD_LIMIT);
  });
});

describe('RaceReportService', () => {
  function setup(opts: { shareToken?: string | null; posted?: boolean; missing?: boolean } = {}) {
    const raceResults = {
      findByIdOrThrow: vi.fn(async () => {
        if (opts.missing) throw new NotFoundException('Race result not found');
        return { ...base, shareToken: opts.shareToken ?? null, teamName: 'W2W Red' };
      }),
    };
    const discordBot = { postResultsMessage: vi.fn().mockResolvedValue(opts.posted ?? true) };
    const config = { get: vi.fn(() => 'https://portal.test/') };
    const service = new RaceReportService(raceResults as never, discordBot as never, config as never);
    return { service, discordBot };
  }

  it('links the public share link when the result has one, and nothing otherwise', async () => {
    expect((await setup({ shareToken: 'tok' }).service.getDraft('r1')).discord).toContain('https://portal.test/share/results/tok');
    expect((await setup().service.getDraft('r1')).discord).not.toContain('https://');
  });

  it('404s for an unknown result', async () => {
    await expect(setup({ missing: true }).service.getDraft('r1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ missing: true }).service.post('r1', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('posts the edited text, and says so when Discord does not take it', async () => {
    const ok = setup();
    await expect(ok.service.post('r1', 'my edited text')).resolves.toEqual({ posted: true });
    expect(ok.discordBot.postResultsMessage).toHaveBeenCalledWith('my edited text');
    await expect(setup({ posted: false }).service.post('r1', 'x')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('RaceReportController guards', () => {
  it('needs login for both routes, and the admin role to post', () => {
    expect(Reflect.getMetadata('__guards__', RaceReportController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata('__guards__', RaceReportController.prototype.draft)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', RaceReportController.prototype.post)).toEqual([RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, RaceReportController.prototype.post)).toEqual(['ADMIN']);
  });
});
