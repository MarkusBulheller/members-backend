import { BadGatewayException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingService } from './iracing.service.js';
import { buildFoundMessage, buildImportedMessage, escapeMarkdown } from './iracing-auto-import.messages.js';

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
