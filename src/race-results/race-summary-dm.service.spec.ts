import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { MAX_SUMMARY_DMS_PER_IMPORT, RaceSummaryDmService } from './race-summary-dm.service.js';

const stintFor = (driverProfileId: string | null) => ({
  driverProfileId,
  averageLapTimeMs: 100_000,
  bestLapTimeMs: 98_000,
  incidents: 1,
  lapsComplete: 10,
});

const resultOf = (profileIds: (string | null)[], id = 'res-1') => ({
  id,
  trackName: 'Daytona',
  trackConfig: null,
  seriesName: null,
  startTime: null,
  driverStints: profileIds.map(stintFor),
});

interface Setup {
  profiles?: { id: string; userId: string | null }[];
  users?: { id: string; discordId: string }[];
  sendResult?: boolean | Error;
  profilesError?: Error;
}

function makeService(setup: Setup = {}) {
  const driverProfiles = {
    find: vi.fn(async (..._args: unknown[]) => {
      if (setup.profilesError) throw setup.profilesError;
      return setup.profiles ?? [];
    }),
  };
  const users = { find: vi.fn(async (..._args: unknown[]) => setup.users ?? []) };
  const send = vi.fn(async (..._args: unknown[]) => {
    if (setup.sendResult instanceof Error) throw setup.sendResult;
    return setup.sendResult ?? true;
  });
  const config = { get: vi.fn((_key: string, fallback: string) => fallback) };
  const service = new RaceSummaryDmService(
    driverProfiles as never,
    users as never,
    { sendDirectMessage: send } as never,
    config as never,
  );
  return { service, driverProfiles, users, send };
}

describe('RaceSummaryDmService', () => {
  it('queries only opted-in members and DMs each with a text containing the result link', async () => {
    const { service, driverProfiles, send } = makeService({
      profiles: [{ id: 'p1', userId: 'u1' }],
      users: [{ id: 'u1', discordId: '111' }],
    });
    await service.notifyImported(resultOf(['p1', 'p2', null, 'p1']));
    const query = driverProfiles.find.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(query.where).toHaveProperty('raceSummaryDm', true);
    expect(send).toHaveBeenCalledTimes(1);
    const [discordId, text] = send.mock.calls[0] as [string, string];
    expect(discordId).toBe('111');
    expect(text).toContain('/results/res-1');
    expect(text).toContain('**Your race: Daytona**');
  });

  it('does nothing when no stint is linked to a profile or nobody opted in', async () => {
    const a = makeService();
    await a.service.notifyImported(resultOf([null]));
    expect(a.driverProfiles.find).not.toHaveBeenCalled();
    const b = makeService({ profiles: [] });
    await b.service.notifyImported(resultOf(['p1']));
    expect(b.send).not.toHaveBeenCalled();
  });

  it('skips members without a Discord id, and only looks up APPROVED accounts', async () => {
    const { service, send, users } = makeService({
      profiles: [
        { id: 'p1', userId: 'u1' },
        { id: 'p2', userId: 'u2' },
      ],
      users: [{ id: 'u1', discordId: '' }],
    });
    await service.notifyImported(resultOf(['p1', 'p2']));
    expect(send).not.toHaveBeenCalled();
    const query = users.find.mock.calls[0][0] as { where: { status: UserStatus } };
    expect(query.where.status).toBe(UserStatus.APPROVED);
  });

  it('sends at most one DM per (result, driver) - a second call for the same result is a no-op', async () => {
    const { service, send } = makeService({
      profiles: [{ id: 'p1', userId: 'u1' }],
      users: [{ id: 'u1', discordId: '111' }],
    });
    await service.notifyImported(resultOf(['p1']));
    await service.notifyImported(resultOf(['p1']));
    expect(send).toHaveBeenCalledTimes(1);
    await service.notifyImported(resultOf(['p1'], 'res-2'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it(`caps the DMs at ${MAX_SUMMARY_DMS_PER_IMPORT} per import`, async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const { service, send } = makeService({
      profiles: ids.map((id, i) => ({ id, userId: `u${i}` })),
      users: ids.map((_, i) => ({ id: `u${i}`, discordId: `d${i}` })),
    });
    await service.notifyImported(resultOf(ids));
    expect(send).toHaveBeenCalledTimes(MAX_SUMMARY_DMS_PER_IMPORT);
  });

  it('never throws: a failed send, a thrown send and a failed lookup are all swallowed', async () => {
    const member = { profiles: [{ id: 'p1', userId: 'u1' }], users: [{ id: 'u1', discordId: '1' }] };
    const failed = makeService({ ...member, sendResult: false });
    await expect(failed.service.notifyImported(resultOf(['p1']))).resolves.toBeUndefined();
    const thrown = makeService({ ...member, sendResult: new Error('boom') });
    await expect(thrown.service.notifyImported(resultOf(['p1']))).resolves.toBeUndefined();
    const lookup = makeService({ profilesError: new Error('db down') });
    await expect(lookup.service.notifyImported(resultOf(['p1']))).resolves.toBeUndefined();
  });
});
