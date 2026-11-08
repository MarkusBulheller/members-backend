import { BadGatewayException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingService } from './iracing.service.js';
import { buildFoundMessage, buildImportedEmbed, buildImportedMessage, escapeMarkdown } from './iracing-auto-import.messages.js';

afterEach(() => vi.unstubAllGlobals());

const service = () => {
  const instance = new IracingService({ getOrThrow: vi.fn() } as never);
  // Data API fetches retry transient failures; don't wait between attempts in tests.
  (instance as unknown as { retryDelayMs: number }).retryDelayMs = 0;
  return instance;
};

/** First response: the search envelope; second: the chunk file with the rows. */
function stubSearch(rows: unknown[]) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { chunk_info: { base_download_url: 'https://chunks/', chunk_file_names: ['a.json'] } } }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => rows });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('IracingService.fetchTeamDriverCount', () => {
  const sessionResults = (teamEntry: unknown) => ({
    session_results: [
      { simsession_name: 'QUALIFY', results: [] },
      { simsession_name: 'RACE', results: [{ team_id: -5, driver_results: [{ cust_id: 9 }] }, teamEntry] },
    ],
  });

  it('counts the distinct drivers of the team in the Race session only', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        sessionResults({ team_id: -287336, driver_results: [{ cust_id: 1 }, { cust_id: 2 }, { cust_id: 2 }, { cust_id: 3 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(service().fetchTeamDriverCount('tok', 77, 287336)).resolves.toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a one-driver entry as 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => sessionResults({ team_id: -7, driver_results: [{ cust_id: 4 }] }) }),
    );
    await expect(service().fetchTeamDriverCount('tok', 77, 7)).resolves.toBe(1);
  });

  it('throws when the team has no entry in the session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => sessionResults({ team_id: -8, driver_results: [] }) }));
    await expect(service().fetchTeamDriverCount('tok', 77, 7)).rejects.toThrow('No result found for that team');
  });
});

describe('IracingService.searchTeamResultRows', () => {
  it('returns subsession ids plus the end time and display fields (positions converted to 1-indexed)', async () => {
    const fetchMock = stubSearch([
      {
        subsession_id: 77,
        start_time: '2026-10-24T12:00:00Z',
        end_time: '2026-10-24T14:00:00Z',
        series_name: 'IMSA Endurance',
        track: { track_id: 1, track_name: 'Daytona' },
        car_name: 'BMW M4 GT3',
        finish_position: 6,
        finish_position_in_class: 2,
        laps_complete: 120,
      },
      { subsession_id: 78 },
      { nothing: true },
    ]);
    const rows = await service().searchTeamResultRows('tok', -287336, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-24T15:00:00Z'));

    expect(rows).toEqual([
      {
        subsessionId: 77,
        startTime: '2026-10-24T12:00:00Z',
        endTime: '2026-10-24T14:00:00Z',
        seriesName: 'IMSA Endurance',
        trackName: 'Daytona',
        carName: 'BMW M4 GT3',
        finishingPosition: 7,
        finishingPositionInClass: 3,
        lapsComplete: 120,
      },
      {
        subsessionId: 78,
        startTime: null,
        endTime: null,
        seriesName: null,
        trackName: null,
        carName: null,
        finishingPosition: null,
        finishingPositionInClass: null,
        lapsComplete: null,
      },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('team_id=287336');
  });

  it('the old number[] method still works through it', async () => {
    stubSearch([{ subsession_id: 5 }, { subsession_id: 6 }]);
    await expect(service().searchTeamResults('tok', 1, new Date(), new Date())).resolves.toEqual([5, 6]);
  });

  it('a failed search call throws for the new method but still reads as empty for the old one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' }));
    await expect(service().searchTeamResultRows('tok', 1, new Date(), new Date())).rejects.toBeInstanceOf(BadGatewayException);
    await expect(service().searchTeamResults('tok', 1, new Date(), new Date())).resolves.toEqual([]);
  });
});

describe('buildImportedEmbed', () => {
  const full = {
    id: 'abc',
    seriesName: 'IMSA_Endurance',
    trackName: 'Daytona',
    trackConfig: 'Road Course',
    carName: 'BMW M4 GT3',
    finishingPositionInClass: 1,
    finishingPosition: 4,
    teamLapsComplete: 120,
    totalLaps: 125,
    teamIncidents: 4,
    teamName: 'W2W Red',
    splitNumber: 2,
    totalSplits: 5,
    endTime: new Date('2026-10-24T14:00:00Z'),
    driverStints: [
      { displayName: 'Anna_B', averageLapTimeMs: 90_000, bestLapTimeMs: 88_500, incidents: 1, lapsComplete: 40 },
      { displayName: 'Ben', averageLapTimeMs: 91_000, bestLapTimeMs: 87_123, incidents: 3, lapsComplete: 80 },
    ],
  };

  it('puts series and track in the escaped title, links to the result and colours a win gold', () => {
    const embed = buildImportedEmbed(full, 'https://portal.test/');
    expect(embed.title).toBe('🏁 IMSA\\_Endurance — Daytona — Road Course');
    expect(embed.url).toBe('https://portal.test/results/abc');
    expect(embed.color).toBe(0xf5c542);
    expect(embed.footer?.text).toBe('W2W Red · Split 2/5');
    expect(embed.timestamp).toBe('2026-10-24T14:00:00.000Z');
  });

  it('lists the finish, laps, incidents, car, best lap and each driver', () => {
    const fields = Object.fromEntries((buildImportedEmbed(full, 'https://p').fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Result).toBe('P1 in class (P4 overall)');
    expect(fields.Laps).toBe('120 of 125');
    expect(fields.Incidents).toBe('4');
    expect(fields.Car).toBe('BMW M4 GT3');
    expect(fields['Best lap']).toBe('1:27.123 · Ben');
    // 90 s * 40 laps = 1 h 0 m; 91 s * 80 laps = 2 h 01 m
    expect(fields.Drivers).toBe('**Anna\\_B** — 1h 00m · best 1:28.500 · 1 inc\n**Ben** — 2h 01m · best 1:27.123 · 3 inc');
  });

  it('colours silver, bronze and the rest, and copes with a result that has almost nothing', () => {
    const colorFor = (place: number | null) =>
      buildImportedEmbed({ ...full, finishingPositionInClass: place, finishingPosition: place }, 'https://p').color;
    expect(colorFor(2)).toBe(0xc0c0c8);
    expect(colorFor(3)).toBe(0xcd7f32);
    expect(colorFor(9)).toBe(0xe10600);

    const sparse = buildImportedEmbed(
      { id: 'x', seriesName: null, trackName: 'Spa', finishingPositionInClass: null, finishingPosition: 9, teamLapsComplete: null, teamIncidents: null },
      'https://p',
    );
    expect(sparse.title).toBe('🏁 Spa');
    expect(sparse.fields).toEqual([{ name: 'Result', value: 'P9 overall', inline: true }]);
    expect(sparse.footer).toBeUndefined();
    expect(sparse.timestamp).toBeUndefined();
  });

  it('keeps long driver lists within the field limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      displayName: `A very long driver name number ${i}`,
      averageLapTimeMs: 90_000,
      bestLapTimeMs: 88_000,
      incidents: 2,
      lapsComplete: 30,
    }));
    const drivers = buildImportedEmbed({ ...full, driverStints: many }, 'https://p').fields?.find((f) => f.name === 'Drivers');
    expect((drivers?.value.length ?? 0) <= 1024).toBe(true);
  });
});

describe('auto-import Discord messages', () => {
  it('formats the imported message and omits unknown parts', () => {
    const text = buildImportedMessage(
      {
        id: 'abc',
        seriesName: 'IMSA_Endurance',
        trackName: 'Daytona',
        finishingPositionInClass: 3,
        finishingPosition: 7,
        teamLapsComplete: 120,
        teamIncidents: 4,
      },
      'https://portal.test/',
    );
    expect(text).toBe(
      '🏁 **Result imported** · IMSA\\_Endurance · Daytona · P3 in class (P7 overall) · 120 laps · 4 incidents\n<https://portal.test/results/abc>',
    );
    const sparse = buildImportedMessage(
      { id: 'x', seriesName: null, trackName: 'Spa', finishingPositionInClass: null, finishingPosition: 9, teamLapsComplete: null, teamIncidents: null },
      'https://portal.test',
    );
    expect(sparse).toBe('🏁 **Result imported** · Spa · P9 overall\n<https://portal.test/results/x>');
  });

  it('formats the found message with the admin route', () => {
    const text = buildFoundMessage(
      { seriesName: 'IMSA', trackName: 'Daytona', finishingPositionInClass: 3, finishingPosition: 7 } as never,
      'W2W *Red*',
      'https://portal.test',
    );
    expect(text).toBe(
      '🏁 **New result available** · IMSA · Daytona · P3 in class · W2W \\*Red\\* — an admin can import it in the portal: <https://portal.test/admin/settings/auto-import>',
    );
  });

  it('escapes markdown characters', () => {
    expect(escapeMarkdown('a*b_c~d`e|f>g\\h')).toBe('a\\*b\\_c\\~d\\`e\\|f\\>g\\\\h');
  });
});

describe('IracingAdminTokenService token acquisition', () => {
  it('serialises concurrent acquisitions so a single-use refresh token is never used twice', async () => {
    const order: string[] = [];
    let stored = 'r0';
    const driversService = {
      findByUserIdWithRefreshToken: vi.fn(async () => {
        order.push(`read:${stored}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id: 'p1', iracingRefreshToken: stored };
      }),
      setIracingRefreshToken: vi.fn(async (_id: string, token: string | null) => {
        stored = token as string;
        order.push(`write:${stored}`);
      }),
      clearIracingRefreshToken: vi.fn(),
    };
    let n = 0;
    const iracingService = {
      refreshAccessToken: vi.fn(async (refresh: string) => {
        n += 1;
        return refresh === stored ? { accessToken: `a${n}`, refreshToken: `r${n}` } : null;
      }),
    };
    const usersRepository = { find: vi.fn().mockResolvedValue([{ id: 'admin-1' }]) };
    const tokens = new IracingAdminTokenService(usersRepository as never, driversService as never, iracingService as never);

    const [a, b, c] = await Promise.all([
      tokens.getSystemAccessToken(),
      tokens.getAccessToken('admin-1'),
      tokens.getSystemAccessToken(),
    ]);

    expect([a, b, c]).toEqual(['a1', 'a2', 'a3']);
    expect(driversService.clearIracingRefreshToken).not.toHaveBeenCalled();
    expect(order).toEqual(['read:r0', 'write:r1', 'read:r1', 'write:r2', 'read:r2', 'write:r3']);
  });

  it('keeps working after a failed acquisition', async () => {
    const driversService = {
      findByUserIdWithRefreshToken: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'p', iracingRefreshToken: 'r' }),
      setIracingRefreshToken: vi.fn(),
      clearIracingRefreshToken: vi.fn(),
    };
    const iracingService = { refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r2' }) };
    const tokens = new IracingAdminTokenService({ find: vi.fn() } as never, driversService as never, iracingService as never);
    await expect(tokens.getAccessToken('x')).rejects.toThrow();
    await expect(tokens.getAccessToken('x')).resolves.toBe('a');
  });
});
