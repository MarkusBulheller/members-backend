import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_OVERLAP_MS,
  IracingResultAutoImportService,
  MAX_IMPORTS_PER_RUN,
  MAX_TRIES,
  SEARCH_LOOKBACK_MS,
  TOKEN_ALERT_INTERVAL_MS,
} from './iracing-result-auto-import.service.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-10-24T12:00:00.000Z');

type Row = Record<string, unknown>;

function unwrap(value: unknown): unknown {
  return value instanceof FindOperator ? value.value : value;
}

/** Minimal in-memory stand-in for a TypeORM repository: equality / In() filters only. */
function fakeRepository(initial: Row[] = [], idPrefix = 'id') {
  const rows: Row[] = initial.map((row, index) => ({ id: `${idPrefix}-${index}`, ...row }));
  let counter = rows.length;
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, expected]) => {
      const value = unwrap(expected);
      return Array.isArray(value) ? value.includes(row[key]) : row[key] === value;
    });
  return {
    rows,
    find: vi.fn(async (options: { where?: Row; take?: number } = {}) => {
      const found = rows.filter((row) => matches(row, options.where ?? {}));
      return options.take ? found.slice(0, options.take) : found;
    }),
    findOne: vi.fn(async (options: { where: Row }) => rows.find((row) => matches(row, options.where)) ?? null),
    create: vi.fn((data: Row) => ({ ...data })),
    save: vi.fn(async (row: Row) => {
      if (!row.id) {
        row.id = `${idPrefix}-${counter++}`;
        row.createdAt = NOW;
        rows.push(row);
      }
      return row;
    }),
    update: vi.fn(async (where: Row, patch: Row) => {
      for (const row of rows.filter((r) => matches(r, where))) Object.assign(row, patch);
    }),
  };
}

function searchRow(subsessionId: number, endedMinutesAgo: number | null, extra: Row = {}) {
  return {
    subsessionId,
    startTime: new Date(NOW.getTime() - (endedMinutesAgo ?? 0) * MIN - 3 * HOUR).toISOString(),
    endTime: endedMinutesAgo === null ? null : new Date(NOW.getTime() - endedMinutesAgo * MIN).toISOString(),
    seriesName: 'IMSA Endurance',
    trackName: 'Daytona',
    carName: 'BMW M4 GT3',
    finishingPositionInClass: 3,
    finishingPosition: 7,
    lapsComplete: 100,
    ...extra,
  };
}

interface HarnessOptions {
  settings?: Partial<{ enabled: boolean; mode: 'NOTIFY' | 'AUTO'; delayMinutes: number; enabledSince: Date | null }>;
  teams?: Row[];
  attempts?: Row[];
  results?: Row[];
  token?: string | null;
  rows?: ReturnType<typeof searchRow>[];
  alertUserId?: string | null;
}

function makeHarness(options: HarnessOptions = {}) {
  const settingsRow = {
    enabled: true,
    mode: 'NOTIFY' as const,
    delayMinutes: 20,
    enabledSince: new Date(NOW.getTime() - 24 * HOUR),
    ...options.settings,
  };
  const teams = fakeRepository(
    options.teams ?? [{ teamId: 100, teamName: 'W2W Red', active: true, autoImport: true, lastCheckedAt: null }],
    'team',
  );
  const attempts = fakeRepository(options.attempts ?? [], 'att');
  const results = fakeRepository(options.results ?? [], 'res');
  const settings = { getRow: vi.fn(async () => settingsRow), recordRun: vi.fn().mockResolvedValue(undefined) };
  const adminToken = { getSystemAccessToken: vi.fn().mockResolvedValue(options.token === undefined ? 'tok' : options.token) };
  const iracing = { searchTeamResultRows: vi.fn().mockResolvedValue(options.rows ?? []) };
  const raceResults = {
    importWithOptions: vi.fn(async (subsessionId: number) => ({
      id: `result-${subsessionId}`,
      seriesName: 'IMSA Endurance',
      trackName: 'Daytona',
      finishingPositionInClass: 2,
      finishingPosition: 5,
      teamLapsComplete: 99,
      teamIncidents: 4,
    })),
  };
  const discord = {
    postResultsMessage: vi.fn().mockResolvedValue(true),
    sendDirectMessage: vi.fn().mockResolvedValue(true),
  };
  const discordSettings = {
    getInteractionConfig: vi
      .fn()
      .mockResolvedValue({ publicKey: null, alertUserId: options.alertUserId === undefined ? '111111111111111111' : options.alertUserId }),
  };
  const config = { get: vi.fn((_key: string, fallback?: string) => fallback ?? 'https://portal.test') };
  const service = new IracingResultAutoImportService(
    attempts as never,
    teams as never,
    results as never,
    settings as never,
    adminToken as never,
    iracing as never,
    raceResults as never,
    discord as never,
    discordSettings as never,
    config as never,
  );
  return { service, settingsRow, teams, attempts, results, settings, adminToken, iracing, raceResults, discord };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('IracingResultAutoImportService.run - guards', () => {
  it('does nothing and records nothing while switched off', async () => {
    const h = makeHarness({ settings: { enabled: false } });
    const summary = await h.service.run();
    expect(summary.status).toBe('SKIPPED');
    expect(h.iracing.searchTeamResultRows).not.toHaveBeenCalled();
    expect(h.settings.recordRun).not.toHaveBeenCalled();
  });

  it('reports OK without touching iRacing when no team is watched', async () => {
    const h = makeHarness({ teams: [{ teamId: 100, teamName: 'x', active: true, autoImport: false }] });
    const summary = await h.service.run();
    expect(summary.status).toBe('OK');
    expect(h.adminToken.getSystemAccessToken).not.toHaveBeenCalled();
    expect(h.settings.recordRun).toHaveBeenCalledWith('OK', expect.stringContaining('No teams'));
  });

  it('ignores inactive teams even when autoImport is set', async () => {
    const h = makeHarness({ teams: [{ teamId: 100, teamName: 'x', active: false, autoImport: true }] });
    await h.service.run();
    expect(h.iracing.searchTeamResultRows).not.toHaveBeenCalled();
  });

  it('is SKIPPED with a message and a single DM per 12h when no admin has a working iRacing link', async () => {
    const h = makeHarness({ token: null });
    const first = await h.service.run();
    expect(first.status).toBe('SKIPPED');
    expect(h.settings.recordRun).toHaveBeenLastCalledWith('SKIPPED', expect.stringContaining('iRacing link'));
    expect(h.discord.sendDirectMessage).toHaveBeenCalledTimes(1);

    await h.service.run();
    expect(h.discord.sendDirectMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + TOKEN_ALERT_INTERVAL_MS + MIN));
    await h.service.run();
    expect(h.discord.sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(h.iracing.searchTeamResultRows).not.toHaveBeenCalled();
  });

  it('sends no DM when no alert user is configured', async () => {
    const h = makeHarness({ token: null, alertUserId: null });
    await h.service.run();
    expect(h.discord.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('never runs concurrently with itself', async () => {
    const h = makeHarness({ rows: [] });
    let release: () => void = () => undefined;
    h.iracing.searchTeamResultRows.mockReturnValue(new Promise((resolve) => (release = () => resolve([]))));
    const first = h.service.run();
    await vi.advanceTimersByTimeAsync(0);
    const second = await h.service.run();
    expect(second.status).toBe('SKIPPED');
    expect(second.message).toContain('still running');
    release();
    await first;
    expect(h.iracing.searchTeamResultRows).toHaveBeenCalledTimes(1);
  });

  it('never throws out of the cron, and records the error', async () => {
    const h = makeHarness();
    h.adminToken.getSystemAccessToken.mockRejectedValue(new Error('db down'));
    await expect(h.service.poll()).resolves.toBeUndefined();
    expect(h.settings.recordRun).toHaveBeenCalledWith('ERROR', expect.stringContaining('db down'));

    const broken = makeHarness();
    broken.settings.getRow.mockRejectedValue(new Error('no settings'));
    await expect(broken.service.poll()).resolves.toBeUndefined();
  });
});

describe('IracingResultAutoImportService.run - discovery window', () => {
  it('searches from enabledSince (minus the start lookback) up to now on the first check', async () => {
    const enabledSince = new Date(NOW.getTime() - 5 * HOUR);
    const h = makeHarness({ settings: { enabledSince } });
    await h.service.run();
    const [token, teamId, begin, end] = h.iracing.searchTeamResultRows.mock.calls[0];
    expect(token).toBe('tok');
    expect(teamId).toBe(100);
    expect((begin as Date).getTime()).toBe(enabledSince.getTime() - SEARCH_LOOKBACK_MS);
    expect(end).toEqual(NOW);
  });

  it('continues from lastCheckedAt minus the overlap, never before enabledSince', async () => {
    const enabledSince = new Date(NOW.getTime() - 3 * HOUR);
    const lastCheckedAt = new Date(NOW.getTime() - 1 * HOUR);
    const h = makeHarness({
      settings: { enabledSince },
      teams: [{ teamId: 100, teamName: 'x', active: true, autoImport: true, lastCheckedAt }],
    });
    await h.service.run();
    // lastChecked - 2h is earlier than enabledSince, so enabledSince wins.
    expect((h.iracing.searchTeamResultRows.mock.calls[0][2] as Date).getTime()).toBe(
      enabledSince.getTime() - SEARCH_LOOKBACK_MS,
    );

    const later = makeHarness({
      settings: { enabledSince: new Date(NOW.getTime() - 30 * HOUR) },
      teams: [{ teamId: 100, teamName: 'x', active: true, autoImport: true, lastCheckedAt }],
    });
    await later.service.run();
    expect((later.iracing.searchTeamResultRows.mock.calls[0][2] as Date).getTime()).toBe(
      lastCheckedAt.getTime() - CHECK_OVERLAP_MS - SEARCH_LOOKBACK_MS,
    );
  });

  it('only keeps sessions that ended after the window start and at least delayMinutes ago', async () => {
    const h = makeHarness({
      settings: { delayMinutes: 20, enabledSince: new Date(NOW.getTime() - 5 * HOUR) },
      rows: [
        searchRow(1, 10), // too fresh
        searchRow(2, 25), // ok
        searchRow(3, 20), // exactly at the delay -> ok
        searchRow(4, 6 * 60), // ended before auto-import was switched on
        searchRow(5, null), // no end_time
      ],
    });
    const summary = await h.service.run();
    expect(summary.found).toBe(2);
    expect(h.attempts.rows.map((row) => row.subsessionId).sort()).toEqual([2, 3]);
  });

  it('creates FOUND attempts carrying the search row data and updates lastCheckedAt', async () => {
    const h = makeHarness({ rows: [searchRow(2, 25)] });
    await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({
      subsessionId: 2,
      teamId: 100,
      status: 'FOUND',
      tries: 0,
      seriesName: 'IMSA Endurance',
      trackName: 'Daytona',
      carName: 'BMW M4 GT3',
      finishingPositionInClass: 3,
      finishingPosition: 7,
      lapsComplete: 100,
    });
    expect(h.teams.rows[0].lastCheckedAt).toEqual(NOW);
  });

  it('skips sessions that are already imported, or attempted as IMPORTED / IGNORED', async () => {
    const h = makeHarness({
      rows: [searchRow(1, 30), searchRow(2, 30), searchRow(3, 30), searchRow(4, 30)],
      results: [{ subsessionId: 1, teamId: 100 }],
      attempts: [
        { subsessionId: 2, teamId: 100, status: 'IMPORTED', tries: 0 },
        { subsessionId: 3, teamId: 100, status: 'IGNORED', tries: 0 },
      ],
    });
    const summary = await h.service.run();
    expect(summary.found).toBe(1);
    expect(h.attempts.rows.filter((row) => row.subsessionId === 4)).toHaveLength(1);
    expect(h.attempts.rows.filter((row) => row.subsessionId === 3)[0].status).toBe('IGNORED');
    expect(h.attempts.rows.filter((row) => row.subsessionId === 1)).toHaveLength(0);
  });

  it('marks an existing FOUND attempt IMPORTED when the result was imported by hand meanwhile', async () => {
    const h = makeHarness({
      rows: [searchRow(1, 30)],
      results: [{ id: 'manual-result', subsessionId: 1, teamId: 100 }],
      attempts: [{ subsessionId: 1, teamId: 100, status: 'FOUND', tries: 0 }],
    });
    await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({ status: 'IMPORTED', raceResultId: 'manual-result' });
    expect(h.discord.postResultsMessage).not.toHaveBeenCalled();
  });

  it('does not advance lastCheckedAt when the iRacing search fails, and reports ERROR', async () => {
    const h = makeHarness();
    h.iracing.searchTeamResultRows.mockRejectedValue(new Error('iRacing result search failed'));
    const summary = await h.service.run();
    expect(summary.status).toBe('ERROR');
    expect(summary.message).toContain('W2W Red');
    expect(h.teams.rows[0].lastCheckedAt).toBeNull();
    expect(h.settings.recordRun).toHaveBeenCalledWith('ERROR', expect.any(String));
  });

  it('keeps going with the other teams when one search fails', async () => {
    const h = makeHarness({
      teams: [
        { teamId: 100, teamName: 'A', active: true, autoImport: true, lastCheckedAt: null },
        { teamId: 200, teamName: 'B', active: true, autoImport: true, lastCheckedAt: null },
      ],
    });
    h.iracing.searchTeamResultRows.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([searchRow(9, 30)]);
    const summary = await h.service.run();
    expect(summary.status).toBe('ERROR');
    expect(summary.found).toBe(1);
    expect(h.teams.rows[0].lastCheckedAt).toBeNull();
    expect(h.teams.rows[1].lastCheckedAt).toEqual(NOW);
  });
});

describe('IracingResultAutoImportService.run - NOTIFY mode', () => {
  it('posts the found message once and does not import', async () => {
    const h = makeHarness({ rows: [searchRow(2, 25)] });
    await h.service.run();
    expect(h.raceResults.importWithOptions).not.toHaveBeenCalled();
    expect(h.discord.postResultsMessage).toHaveBeenCalledTimes(1);
    const message = h.discord.postResultsMessage.mock.calls[0][0] as string;
    expect(message).toContain('New result available');
    expect(message).toContain('P3 in class');
    expect(message).toContain('W2W Red');
    expect(message).toContain('/admin/settings/auto-import');
    expect(h.attempts.rows[0].announcedAt).toBeInstanceOf(Date);

    h.iracing.searchTeamResultRows.mockResolvedValue([searchRow(2, 25)]);
    await h.service.run();
    expect(h.discord.postResultsMessage).toHaveBeenCalledTimes(1);
  });

  it('retries the announcement later when posting failed', async () => {
    const h = makeHarness({ rows: [searchRow(2, 25)] });
    h.discord.postResultsMessage.mockResolvedValueOnce(false);
    await h.service.run();
    expect(h.attempts.rows[0].announcedAt).toBeFalsy();
    h.iracing.searchTeamResultRows.mockResolvedValue([]);
    await h.service.run();
    expect(h.discord.postResultsMessage).toHaveBeenCalledTimes(2);
    expect(h.attempts.rows[0].announcedAt).toBeInstanceOf(Date);
  });
});

describe('IracingResultAutoImportService.run - AUTO mode', () => {
  it('imports as AUTO with the run token, marks the attempt IMPORTED and posts the imported message', async () => {
    const h = makeHarness({ settings: { mode: 'AUTO' }, rows: [searchRow(2, 25)] });
    const summary = await h.service.run();
    expect(h.raceResults.importWithOptions).toHaveBeenCalledWith(2, 100, { source: 'AUTO', accessToken: 'tok' });
    expect(summary).toMatchObject({ status: 'OK', found: 1, imported: 1 });
    expect(h.attempts.rows[0]).toMatchObject({ status: 'IMPORTED', raceResultId: 'result-2', lastError: null });
    const message = h.discord.postResultsMessage.mock.calls[0][0] as string;
    expect(message).toContain('Result imported');
    expect(message).toContain('P2 in class (P5 overall)');
    expect(message).toContain('99 laps');
    expect(message).toContain('4 incidents');
    expect(message).toContain('/results/result-2');
  });

  it(`imports at most ${MAX_IMPORTS_PER_RUN} per run and picks up the rest next run`, async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => searchRow(id, 30 + id));
    const h = makeHarness({ settings: { mode: 'AUTO' }, rows });
    const first = await h.service.run();
    expect(first.imported).toBe(MAX_IMPORTS_PER_RUN);
    expect(h.attempts.rows.filter((row) => row.status === 'FOUND')).toHaveLength(2);

    h.iracing.searchTeamResultRows.mockResolvedValue([]);
    const second = await h.service.run();
    expect(second.imported).toBe(2);
    expect(h.attempts.rows.every((row) => row.status === 'IMPORTED')).toBe(true);
  });

  it('also imports attempts found earlier in NOTIFY mode once the mode is switched', async () => {
    const h = makeHarness({
      settings: { mode: 'AUTO' },
      attempts: [{ subsessionId: 7, teamId: 100, status: 'FOUND', tries: 0, announcedAt: NOW }],
    });
    await h.service.run();
    expect(h.raceResults.importWithOptions).toHaveBeenCalledWith(7, 100, { source: 'AUTO', accessToken: 'tok' });
  });

  it('counts a failure (tries, lastError), retries next run, then gives up on the 5th with one DM', async () => {
    const h = makeHarness({ settings: { mode: 'AUTO' }, rows: [searchRow(2, 25)] });
    h.raceResults.importWithOptions.mockRejectedValue(new Error('iRacing said no'));

    await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({ status: 'FOUND', tries: 1, lastError: 'iRacing said no' });
    expect(h.discord.sendDirectMessage).not.toHaveBeenCalled();

    for (let i = 2; i < MAX_TRIES; i++) await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({ status: 'FOUND', tries: MAX_TRIES - 1 });

    await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({ status: 'FAILED', tries: MAX_TRIES, lastError: 'iRacing said no' });
    expect(h.discord.sendDirectMessage).toHaveBeenCalledTimes(1);

    // FAILED attempts are no longer retried and no more alerts are sent.
    await h.service.run();
    expect(h.raceResults.importWithOptions).toHaveBeenCalledTimes(MAX_TRIES);
    expect(h.discord.sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(h.discord.postResultsMessage).not.toHaveBeenCalled();
  });

  it('links an attempt to the existing result when the import reports it already exists', async () => {
    const h = makeHarness({ settings: { mode: 'AUTO' }, rows: [searchRow(2, 25)] });
    h.raceResults.importWithOptions.mockImplementation(async () => {
      h.results.rows.push({ id: 'dup', subsessionId: 2, teamId: 100 });
      throw new ConflictException('This result has already been added.');
    });
    await h.service.run();
    expect(h.attempts.rows[0]).toMatchObject({ status: 'IMPORTED', raceResultId: 'dup' });
  });
});

describe('IracingResultAutoImportService admin actions', () => {
  const attemptRow = (extra: Row = {}) => ({
    id: 'att-x',
    subsessionId: 5,
    teamId: 100,
    status: 'FOUND',
    tries: 0,
    createdAt: NOW,
    ...extra,
  });

  it('imports now as MANUAL with the admin and returns the attempt and the result id', async () => {
    const h = makeHarness({ attempts: [attemptRow()] });
    h.attempts.rows[0].id = 'att-x';
    const out = await h.service.importNow('att-x', 'admin-1');
    expect(h.raceResults.importWithOptions).toHaveBeenCalledWith(5, 100, { source: 'MANUAL', adminUserId: 'admin-1' });
    expect(out.raceResultId).toBe('result-5');
    expect(out.attempt).toMatchObject({ id: 'att-x', status: 'IMPORTED', teamName: 'W2W Red', raceResultId: 'result-5' });
  });

  it('answers 409 when the attempt is already imported and 404 for an unknown id', async () => {
    const h = makeHarness({ attempts: [attemptRow({ status: 'IMPORTED' })] });
    h.attempts.rows[0].id = 'att-x';
    await expect(h.service.importNow('att-x', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.importNow('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.ignore('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks FAILED with the error on a failed manual import and rethrows it (keeping its HTTP status)', async () => {
    const h = makeHarness({ attempts: [attemptRow()] });
    h.attempts.rows[0].id = 'att-x';
    h.raceResults.importWithOptions.mockRejectedValue(new BadRequestException('Link your own iRacing account first'));
    await expect(h.service.importNow('att-x', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.attempts.rows[0]).toMatchObject({
      status: 'FAILED',
      tries: 1,
      lastError: 'Link your own iRacing account first',
    });
  });

  it('ignores an attempt', async () => {
    const h = makeHarness({ attempts: [attemptRow()] });
    h.attempts.rows[0].id = 'att-x';
    const view = await h.service.ignore('att-x');
    expect(view.status).toBe('IGNORED');
    await expect(h.service.ignore('att-x')).resolves.toMatchObject({ status: 'IGNORED' });
  });

  it('lists attempts with the team name, filtered by status', async () => {
    const h = makeHarness({
      attempts: [attemptRow({ id: 'a' }), attemptRow({ id: 'b', subsessionId: 6, status: 'FAILED' })],
    });
    const failed = await h.service.listAttempts('FAILED', 10);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ subsessionId: 6, teamName: 'W2W Red', status: 'FAILED' });
    expect(Object.keys(failed[0]).sort()).toEqual(
      [
        'carName',
        'createdAt',
        'endTime',
        'finishingPosition',
        'finishingPositionInClass',
        'id',
        'lapsComplete',
        'lastError',
        'raceResultId',
        'seriesName',
        'startTime',
        'status',
        'subsessionId',
        'teamId',
        'teamName',
        'trackName',
        'tries',
      ].sort(),
    );
  });
});
