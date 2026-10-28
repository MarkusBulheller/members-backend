import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { Sim } from '../common/enums/sim.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { EventTeamThreadController } from './event-team-thread.controller.js';
import {
  buildPlanSummaryMessages,
  buildStarterMessage,
  buildThreadName,
  EventTeamThreadService,
  MAX_SUMMARY_MESSAGES,
  MAX_THREAD_MEMBERS,
  SUMMARY_COOLDOWN_MS,
} from './event-team-thread.service.js';

const GREEN_FLAG = Date.parse('2026-10-24T13:10:00.000Z'); // timeslot 13:00 + 10 min offset
const UNIX = Math.floor(GREEN_FLAG / 1000);

function setup(
  opts: {
    team?: Record<string, unknown> | null;
    follow?: { enabled: boolean; token: string | null };
    signups?: Record<string, unknown>[];
    users?: Record<string, unknown>[];
    stints?: Record<string, unknown>[];
    threadAlive?: boolean;
  } = {},
) {
  const team =
    opts.team === undefined
      ? {
          id: 't1',
          eventId: 'e1',
          name: 'W2W #1',
          carId: 'car1',
          discordThreadId: null,
          timeslot: { id: 'ts1', startsAt: new Date('2026-10-24T13:00:00.000Z') },
          raceStartOffsetMinutes: '10',
          refuelDurationSeconds: '60',
          tyreChangeDurationSeconds: '120',
          pitstopDrivethroughSeconds: '0',
        }
      : opts.team;
  const repos = {
    events: {
      findOne: vi.fn().mockResolvedValue({
        id: 'e1',
        title: 'Spa 6h',
        sim: Sim.IRACING,
        raceLengthMinutes: 360,
        track: { name: 'Spa-Francorchamps' },
      }),
    },
    teams: { findOne: vi.fn().mockResolvedValue(team), update: vi.fn().mockResolvedValue(undefined) },
    stints: {
      find: vi.fn().mockResolvedValue(
        opts.stints ?? [
          { id: 's1', order: 0, driverUserId: 'u1', durationMinutes: '60', tyreChange: true, tyresChanged: null, actualStartAt: null },
          { id: 's2', order: 1, driverUserId: 'd1', durationMinutes: '90', tyreChange: true, tyresChanged: null, actualStartAt: null },
        ],
      ),
    },
    dummies: { find: vi.fn().mockResolvedValue([{ id: 'd1', eventTeamId: 't1', name: 'Guest *Gustav*' }]) },
    signups: {
      find: vi.fn().mockResolvedValue(
        opts.signups ?? [
          { userId: 'u1', eventTeamId: 't1' },
          { userId: 'u2', eventTeamId: 't1' },
          { userId: 'u3', eventTeamId: 't1' },
        ],
      ),
    },
    users: {
      find: vi.fn().mockResolvedValue(
        opts.users ?? [
          { id: 'u1', discordId: '111111111111', status: UserStatus.APPROVED, discordUsername: 'alex' },
          { id: 'u2', discordId: '222222222222', status: UserStatus.SUSPENDED, discordUsername: 'bob' },
          { id: 'u3', discordId: '333333333333', status: UserStatus.APPROVED, discordUsername: 'cat_' },
        ],
      ),
    },
    profiles: {
      find: vi.fn().mockResolvedValue([
        { userId: 'u1', iracingName: 'Alex Rivera', displayName: 'alexr' },
        { userId: 'u2', iracingName: null, displayName: 'Bob' },
        { userId: 'u3', iracingName: 'Cat_Under', displayName: 'cat' },
      ]),
    },
    cars: { findOne: vi.fn().mockResolvedValue({ id: 'car1', name: 'Ferrari 296 GT3' }) },
  };
  const discord = {
    getEventsChannelId: vi.fn().mockResolvedValue('chan'),
    findThreadExists: vi.fn().mockResolvedValue(opts.threadAlive ?? true),
    createTeamThread: vi.fn().mockResolvedValue({ threadId: 'th-new', starterMessageId: 'm1' }),
    addThreadMembers: vi.fn().mockResolvedValue({ added: 2, failed: 0 }),
    postThreadMessage: vi.fn().mockResolvedValue('msg'),
    getGuildIdForChannel: vi.fn().mockResolvedValue('guild1'),
  };
  const follow = { get: vi.fn().mockResolvedValue(opts.follow ?? { enabled: false, token: null, namesMode: 'FULL' }) };
  const config = { get: (_k: string, fallback?: string) => (_k === 'FRONTEND_URL' ? 'https://w2w.test/' : fallback) };
  const service = new EventTeamThreadService(
    repos.events as never,
    repos.teams as never,
    repos.stints as never,
    repos.dummies as never,
    repos.signups as never,
    repos.users as never,
    repos.profiles as never,
    repos.cars as never,
    discord as never,
    follow as never,
    config as never,
  );
  return { service, repos, discord, follow };
}

describe('EventTeamThreadService.ensureThread', () => {
  it('creates the thread, stores its id, adds approved members and returns the url', async () => {
    const { service, repos, discord } = setup();
    const result = await service.ensureThread('e1', 't1', 'admin1');

    expect(result).toEqual({ created: true, threadId: 'th-new', url: 'https://discord.com/channels/guild1/th-new' });
    const call = discord.createTeamThread.mock.calls[0][0];
    expect(call.parentChannelId).toBe('chan');
    expect(call.name).toBe('Spa 6h · W2W #1');
    expect(repos.teams.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { discordThreadId: 'th-new' });
    // u2 is SUSPENDED, so only u1 and u3 are mentioned and added.
    expect(call.mentionUserIds).toEqual(['111111111111', '333333333333']);
    expect(discord.addThreadMembers).toHaveBeenCalledWith('th-new', ['111111111111', '333333333333']);
  });

  it('is idempotent: a live thread is returned as-is without creating anything', async () => {
    const { service, repos, discord } = setup({ team: { id: 't1', eventId: 'e1', name: 'W2W #1', discordThreadId: 'th-old' } });
    const result = await service.ensureThread('e1', 't1', 'admin1');
    expect(result).toEqual({ created: false, threadId: 'th-old', url: 'https://discord.com/channels/guild1/th-old' });
    expect(discord.createTeamThread).not.toHaveBeenCalled();
    expect(repos.teams.update).not.toHaveBeenCalled();
  });

  it('recreates the thread when Discord says the stored one was deleted', async () => {
    const { service, repos, discord } = setup({
      team: {
        id: 't1',
        eventId: 'e1',
        name: 'W2W #1',
        carId: null,
        discordThreadId: 'th-gone',
        timeslot: null,
      },
      threadAlive: false,
    });
    const result = await service.ensureThread('e1', 't1', 'admin1');
    expect(result.created).toBe(true);
    expect(result.threadId).toBe('th-new');
    expect(repos.teams.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { discordThreadId: 'th-new' });
    expect(discord.createTeamThread.mock.calls[0][0].starterContent).toContain('not scheduled yet');
  });

  it('does NOT recreate on a transient Discord error (no duplicate threads)', async () => {
    const { service, discord } = setup({ team: { id: 't1', eventId: 'e1', name: 'x', discordThreadId: 'th-old' } });
    discord.findThreadExists.mockRejectedValue(new Error('502'));
    await expect(service.ensureThread('e1', 't1', 'a')).rejects.toThrow('502');
    expect(discord.createTeamThread).not.toHaveBeenCalled();
  });

  it('surfaces the missing events channel and creates nothing', async () => {
    const { service, discord } = setup();
    discord.getEventsChannelId.mockRejectedValue(new Error('Set the events channel first'));
    await expect(service.ensureThread('e1', 't1', 'a')).rejects.toThrow('Set the events channel first');
    expect(discord.createTeamThread).not.toHaveBeenCalled();
  });

  it('404s for an unknown team', async () => {
    const { service } = setup({ team: null });
    await expect(service.ensureThread('e1', 't1', 'a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adds at most 15 members', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `${100000 + i}`);
    const { service, discord } = setup({
      signups: many.map((_, i) => ({ userId: `u${i}`, eventTeamId: 't1' })),
      users: many.map((id, i) => ({ id: `u${i}`, discordId: id, status: UserStatus.APPROVED, discordUsername: `n${i}` })),
    });
    await service.ensureThread('e1', 't1', 'a');
    expect(discord.addThreadMembers.mock.calls[0][1]).toHaveLength(MAX_THREAD_MEMBERS);
  });

  it('two simultaneous clicks create a single thread', async () => {
    const { service, discord } = setup();
    const [a, b] = await Promise.all([service.ensureThread('e1', 't1', 'x'), service.ensureThread('e1', 't1', 'x')]);
    expect(discord.createTeamThread).toHaveBeenCalledTimes(1);
    expect(a.threadId).toBe('th-new');
    expect(b.threadId).toBe('th-new');
  });

  it('includes the follow link only when it is enabled', async () => {
    const off = setup({ follow: { enabled: false, token: 'SECRETTOKEN' } });
    await off.service.ensureThread('e1', 't1', 'a');
    const offContent = off.discord.createTeamThread.mock.calls[0][0].starterContent as string;
    expect(offContent).not.toContain('SECRETTOKEN');
    expect(offContent).not.toContain('/follow/');

    const on = setup({ follow: { enabled: true, token: 'SECRETTOKEN' } });
    await on.service.ensureThread('e1', 't1', 'a');
    expect(on.discord.createTeamThread.mock.calls[0][0].starterContent).toContain('**Follow live:** https://w2w.test/follow/SECRETTOKEN');
  });

  it('starter message: green flag includes the race-start offset, plan link, escaped names', async () => {
    const { service, discord } = setup();
    await service.ensureThread('e1', 't1', 'a');
    const content = discord.createTeamThread.mock.calls[0][0].starterContent as string;
    expect(content).toContain(`**Green flag:** <t:${UNIX}:F> (<t:${UNIX}:R>)`);
    expect(content).toContain('**Race length:** 6h');
    expect(content).toContain('**Track:** Spa-Francorchamps');
    expect(content).toContain('**Team:** W2W #1 · Ferrari 296 GT3');
    expect(content).toContain('**Plan:** https://w2w.test/events/e1/teams/t1/plan');
    // mention for approved members, plain escaped name for the suspended one and the placeholder
    expect(content).toContain('<@111111111111>');
    expect(content).not.toContain('<@222222222222>');
    expect(content).toContain('Bob');
    expect(content).toContain('Guest \\*Gustav\\*');
  });
});

describe('EventTeamThreadService.getStatus', () => {
  it('reports no thread, a live thread with its url, and a deleted thread as absent', async () => {
    expect(await setup().service.getStatus('e1', 't1')).toEqual({ exists: false, threadId: null, url: null });

    const live = setup({ team: { id: 't1', eventId: 'e1', discordThreadId: 'th1' } });
    expect(await live.service.getStatus('e1', 't1')).toEqual({
      exists: true,
      threadId: 'th1',
      url: 'https://discord.com/channels/guild1/th1',
    });

    const gone = setup({ team: { id: 't1', eventId: 'e1', discordThreadId: 'th1' }, threadAlive: false });
    expect(await gone.service.getStatus('e1', 't1')).toEqual({ exists: false, threadId: null, url: null });
  });

  it('url is null when the guild cannot be determined, and a Discord hiccup does not fail the read', async () => {
    const t = setup({ team: { id: 't1', eventId: 'e1', discordThreadId: 'th1' } });
    t.discord.getGuildIdForChannel.mockResolvedValue(null);
    t.discord.findThreadExists.mockRejectedValue(new Error('down'));
    expect(await t.service.getStatus('e1', 't1')).toEqual({ exists: true, threadId: 'th1', url: null });
  });
});

describe('EventTeamThreadService.postPlanSummary', () => {
  const withThread = { id: 't1', eventId: 'e1', name: 'W2W #1', discordThreadId: 'th1', timeslot: { startsAt: new Date('2026-10-24T13:00:00.000Z') }, raceStartOffsetMinutes: '10', refuelDurationSeconds: '60', tyreChangeDurationSeconds: '120', pitstopDrivethroughSeconds: '0' };

  it('409s when there is no thread yet', async () => {
    const { service, discord } = setup();
    await expect(service.postPlanSummary('e1', 't1')).rejects.toThrow('Create the thread first');
    await expect(service.postPlanSummary('e1', 't1')).rejects.toBeInstanceOf(ConflictException);
    expect(discord.postThreadMessage).not.toHaveBeenCalled();
  });

  it('posts the table and Discord timestamps from the green flag', async () => {
    const { service, discord } = setup({ team: withThread });
    expect(await service.postPlanSummary('e1', 't1')).toEqual({ posted: 1 });
    const [threadId, content] = discord.postThreadMessage.mock.calls[0];
    expect(threadId).toBe('th1');
    expect(content).toContain('```');
    expect(content).toContain('Alex Rivera');
    expect(content).toContain('13:10');
    expect(content).toContain(`Stint 1: <t:${UNIX}:t> Alex Rivera`);
    // second stint = 60 min later + 60 s refuel + 120 s tyres
    expect(content).toContain(`Stint 2: <t:${UNIX + 3600 + 180}:t> Guest \\*Gustav\\*`);
  });

  it('enforces a per-team cooldown (429) but not across teams', async () => {
    const { service, discord } = setup({ team: withThread });
    await service.postPlanSummary('e1', 't1');
    const err = await service.postPlanSummary('e1', 't1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(discord.postThreadMessage).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SUMMARY_COOLDOWN_MS + 1000);
    await expect(service.postPlanSummary('e1', 't1')).resolves.toEqual({ posted: 1 });
    vi.useRealTimers();
  });

  it('does not start the cooldown when nothing could be posted', async () => {
    const { service, discord } = setup({ team: withThread });
    discord.postThreadMessage.mockRejectedValueOnce(new Error('403'));
    await expect(service.postPlanSummary('e1', 't1')).rejects.toThrow('403');
    await expect(service.postPlanSummary('e1', 't1')).resolves.toEqual({ posted: 1 });
  });

  it('409s without stints or without a start time', async () => {
    await expect(setup({ team: withThread, stints: [] }).service.postPlanSummary('e1', 't1')).rejects.toThrow('No stints');
    await expect(
      setup({ team: { ...withThread, timeslot: null } }).service.postPlanSummary('e1', 't1'),
    ).rejects.toThrow('start time');
  });
});

describe('buildPlanSummaryMessages', () => {
  const stints = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      driverName: `Driver Number ${i}`,
      startsAt: new Date(GREEN_FLAG + i * 3_600_000).toISOString(),
      durationMinutes: 60,
    }));

  it('splits a long plan into several messages, each within 1900 chars, with every stint exactly once', () => {
    const messages = buildPlanSummaryMessages('W2W #1', stints(60), GREEN_FLAG);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(m.length).toBeLessThanOrEqual(1900);
      expect(m.match(/```/g)).toHaveLength(2); // one balanced code block per message
    }
    const all = messages.join('\n');
    for (let i = 1; i <= 60; i++) expect(all.match(new RegExp(`^Stint ${i}: `, 'm'))).not.toBeNull();
  });

  it('caps at 8 messages and says how many stints were left out', () => {
    const messages = buildPlanSummaryMessages('W2W #1', stints(600), GREEN_FLAG);
    expect(messages).toHaveLength(MAX_SUMMARY_MESSAGES);
    expect(messages[messages.length - 1]).toMatch(/…and \d+ more stints/);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(1900);
  });

  it('marks stints on later days, shows TBD for unassigned and strips backticks from table names', () => {
    const [message] = buildPlanSummaryMessages(
      'T',
      [
        { driverName: 'Evil```Name', startsAt: new Date(GREEN_FLAG).toISOString(), durationMinutes: 75 },
        { driverName: null, startsAt: new Date(GREEN_FLAG + 24 * 3_600_000).toISOString(), durationMinutes: null },
      ],
      GREEN_FLAG,
    );
    expect(message).toContain('13:10+1');
    expect(message).toContain('TBD');
    expect(message).toContain('1h 15m');
    expect(message.match(/```/g)).toHaveLength(2);
  });
});

describe('buildStarterMessage / buildThreadName', () => {
  it('names the thread "<event> · <team>" within 100 chars', () => {
    expect(buildThreadName('  Spa 6h ', ' W2W #1 ')).toBe('Spa 6h · W2W #1');
    expect(buildThreadName('E'.repeat(200), 'T')).toHaveLength(100);
  });

  it('only mentions drivers that carry a (valid) discord id', () => {
    const { content, mentionUserIds } = buildStarterMessage({
      eventTitle: 'E',
      sim: Sim.LMU,
      trackName: 'T',
      teamName: 'Team',
      carName: null,
      raceStartMs: null,
      raceLengthMinutes: 90,
      drivers: [
        { name: 'A', discordId: '12345678' },
        { name: 'B', discordId: null },
        { name: 'C', discordId: '<@&everyone>' },
      ],
      planUrl: 'https://x/p',
      followUrl: null,
    });
    expect(mentionUserIds).toEqual(['12345678']);
    expect(content).toContain('Le Mans Ultimate');
    expect(content).toContain('**Race length:** 1h 30m');
    expect(content).toContain('<@12345678>, B, C');
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});

describe('EventTeamThreadController', () => {
  it('is ADMIN-only behind JWT + roles guards', () => {
    expect(Reflect.getMetadata('__guards__', EventTeamThreadController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, EventTeamThreadController)).toEqual([Role.ADMIN]);
  });

  it('delegates to the service', async () => {
    const threads = {
      getStatus: vi.fn().mockResolvedValue({ exists: false, threadId: null, url: null }),
      ensureThread: vi.fn().mockResolvedValue({ created: true, threadId: 'th', url: null }),
      postPlanSummary: vi.fn().mockResolvedValue({ posted: 2 }),
    };
    const controller = new EventTeamThreadController(threads as never);
    await controller.get('e', 't');
    await controller.ensure('e', 't', { id: 'admin' } as never);
    expect(await controller.postPlanSummary('e', 't')).toEqual({ posted: 2 });
    expect(threads.ensureThread).toHaveBeenCalledWith('e', 't', 'admin');
  });
});
