import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TEAM_MANAGE_KEY, TeamManageGuard } from '../../auth/team-manage.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { FollowLinkController } from './follow-link.controller.js';
import { FollowLinkService, generateFollowToken } from './follow-link.service.js';
import { PublicFollowController } from './public-follow.controller.js';

const OLD = 'old-token-old-token-old-token-1';

function setup(team: { followToken: string | null; followNames: string; strategyToken?: string | null } | null) {
  const state = team ? { id: 't1', eventId: 'e1', ...team } : null;
  const teamsRepository = {
    findOne: vi.fn().mockResolvedValue(state),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const streams = { notifyRevoked: vi.fn(), notifyChanged: vi.fn() };
  const service = new FollowLinkService(teamsRepository as never, streams as never);
  return { service, teamsRepository, streams };
}

describe('generateFollowToken', () => {
  it('is 32 random bytes as base64url and never repeats', () => {
    const a = generateFollowToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateFollowToken()).not.toBe(a);
  });
});

describe('FollowLinkService', () => {
  it('get: reports a disabled link', async () => {
    const { service, teamsRepository } = setup({ followToken: null, followNames: 'FULL' });
    await expect(service.get('e1', 't1')).resolves.toEqual({ enabled: false, token: null, namesMode: 'FULL', strategy: { enabled: false, token: null } });
    // the team must belong to the event, and the select:false token must be requested explicitly
    expect(teamsRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1', eventId: 'e1' }, select: expect.objectContaining({ followToken: true }) }),
    );
  });

  it('404 when the team is not in that event', async () => {
    const { service } = setup(null);
    await expect(service.get('e1', 't1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('e1', 't1', { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enabled:true mints a token when there is none, without notifying anyone', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: null, followNames: 'FULL' });
    const link = await service.update('e1', 't1', { enabled: true });
    expect(link.enabled).toBe(true);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { followToken: link.token, followNames: 'FULL' });
    expect(streams.notifyRevoked).not.toHaveBeenCalled();
    expect(streams.notifyChanged).not.toHaveBeenCalled();
  });

  it('enabled:true keeps an existing token (idempotent, no write)', async () => {
    const { service, teamsRepository } = setup({ followToken: OLD, followNames: 'FIRST' });
    await expect(service.update('e1', 't1', { enabled: true })).resolves.toEqual({ enabled: true, token: OLD, namesMode: 'FIRST', strategy: { enabled: false, token: null } });
    expect(teamsRepository.update).not.toHaveBeenCalled();
  });

  it('regenerate:true replaces the token and disconnects viewers of the old one', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: OLD, followNames: 'FULL' });
    const link = await service.update('e1', 't1', { regenerate: true });
    expect(link.token).not.toBe(OLD);
    expect(link.enabled).toBe(true);
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { followToken: link.token, followNames: 'FULL' });
    expect(streams.notifyRevoked).toHaveBeenCalledWith('t1', OLD);
  });

  it('enabled:false clears the token (revoke) and disconnects viewers', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: OLD, followNames: 'FULL' });
    await expect(service.update('e1', 't1', { enabled: false })).resolves.toEqual({ enabled: false, token: null, namesMode: 'FULL', strategy: { enabled: false, token: null } });
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { followToken: null, followNames: 'FULL' });
    expect(streams.notifyRevoked).toHaveBeenCalledWith('t1', OLD);
  });

  it('enabled:false wins over regenerate:true', async () => {
    const { service } = setup({ followToken: OLD, followNames: 'FULL' });
    await expect(service.update('e1', 't1', { enabled: false, regenerate: true })).resolves.toMatchObject({
      enabled: false,
      token: null,
    });
  });

  it('namesMode changes alone leave the token untouched and nudge open pages to refetch', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: OLD, followNames: 'FULL' });
    await expect(service.update('e1', 't1', { namesMode: 'INITIALS' })).resolves.toEqual({
      enabled: true,
      token: OLD,
      namesMode: 'INITIALS',
      strategy: { enabled: false, token: null },
    });
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { followToken: OLD, followNames: 'INITIALS' });
    expect(streams.notifyChanged).toHaveBeenCalledWith('t1');
    expect(streams.notifyRevoked).not.toHaveBeenCalled();
  });

  it('namesMode can be set while the link is off', async () => {
    const { service, streams } = setup({ followToken: null, followNames: 'FULL' });
    await expect(service.update('e1', 't1', { namesMode: 'FIRST' })).resolves.toEqual({
      enabled: false,
      token: null,
      namesMode: 'FIRST',
      strategy: { enabled: false, token: null },
    });
    expect(streams.notifyChanged).not.toHaveBeenCalled();
  });
});

describe('FollowLinkService strategy link', () => {
  const STRAT = 'strat-token-strat-token-strat-1';

  it('strategyEnabled:true mints a separate token and leaves the public link alone', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: OLD, followNames: 'FULL', strategyToken: null });
    const link = await service.update('e1', 't1', { strategyEnabled: true });
    expect(link.token).toBe(OLD);
    expect(link.strategy.enabled).toBe(true);
    expect(link.strategy.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.strategy.token).not.toBe(OLD);
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { strategyToken: link.strategy.token });
    expect(streams.notifyRevoked).not.toHaveBeenCalled();
  });

  it('revoking or regenerating the strategy link disconnects only its own viewers', async () => {
    const revoke = setup({ followToken: OLD, followNames: 'FULL', strategyToken: STRAT });
    await expect(revoke.service.update('e1', 't1', { strategyEnabled: false })).resolves.toMatchObject({
      token: OLD,
      strategy: { enabled: false, token: null },
    });
    expect(revoke.teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { strategyToken: null });
    expect(revoke.streams.notifyRevoked).toHaveBeenCalledTimes(1);
    expect(revoke.streams.notifyRevoked).toHaveBeenCalledWith('t1', STRAT);

    const regen = setup({ followToken: OLD, followNames: 'FULL', strategyToken: STRAT });
    const link = await regen.service.update('e1', 't1', { regenerateStrategy: true });
    expect(link.strategy.token).not.toBe(STRAT);
    expect(regen.streams.notifyRevoked).toHaveBeenCalledWith('t1', STRAT);
  });

  it('regenerating the public link no longer disconnects strategy viewers', async () => {
    const { service, streams } = setup({ followToken: OLD, followNames: 'FULL', strategyToken: STRAT });
    await service.update('e1', 't1', { regenerate: true });
    expect(streams.notifyRevoked).toHaveBeenCalledTimes(1);
    expect(streams.notifyRevoked).toHaveBeenCalledWith('t1', OLD);
  });

  it('publishPlan stores the plan for the team and nudges open pages', async () => {
    const { service, teamsRepository, streams } = setup({ followToken: OLD, followNames: 'FULL' });
    await service.publishPlan('e1', 't1', {
      stints: [{ id: 's1', startsAt: '2026-10-24T13:10:00.000Z', endsAt: '2026-10-24T14:10:00.000Z', fuelLiters: 98.5, tyres: 4 }],
    });
    const [where, patch] = teamsRepository.update.mock.calls[0];
    expect(where).toEqual({ id: 't1', eventId: 'e1' });
    expect(patch.publishedPlan).toMatchObject({
      stints: [{ id: 's1', startsAt: '2026-10-24T13:10:00.000Z', endsAt: '2026-10-24T14:10:00.000Z', fuelLiters: 98.5, tyres: 4 }],
    });
    expect(streams.notifyChanged).toHaveBeenCalledWith('t1');
  });

  it('publishPlan fills missing optional values with null and 404s for a team of another event', async () => {
    const { service, teamsRepository } = setup({ followToken: null, followNames: 'FULL' });
    await service.publishPlan('e1', 't1', { stints: [{ id: 's1', startsAt: 'a', endsAt: 'b' }] });
    expect(teamsRepository.update.mock.calls[0][1].publishedPlan).toMatchObject({
      stints: [{ fuelLiters: null, tyres: null }],
    });
    await expect(setup(null).service.publishPlan('e1', 't1', { stints: [] })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('route guards', () => {
  it('follow-link endpoints require login and the team-manage guard (admin or lead of the team)', () => {
    expect(Reflect.getMetadata('__guards__', FollowLinkController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, FollowLinkController)).toBeUndefined();
    for (const method of ['get', 'update', 'publishPlan'] as const) {
      expect(Reflect.getMetadata('__guards__', FollowLinkController.prototype[method])).toEqual([TeamManageGuard]);
      expect(Reflect.getMetadata(TEAM_MANAGE_KEY, FollowLinkController.prototype[method])).toEqual({ from: 'teamParam' });
    }
  });

  it('the public follow controller is deliberately unguarded', () => {
    expect(Reflect.getMetadata('__guards__', PublicFollowController)).toBeUndefined();
    for (const method of ['getState', 'stream'] as const) {
      expect(Reflect.getMetadata('__guards__', PublicFollowController.prototype[method])).toBeUndefined();
    }
  });
});
