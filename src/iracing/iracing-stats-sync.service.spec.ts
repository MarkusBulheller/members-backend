import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { IRACING_RESYNC_COOLDOWN_MS } from '../drivers/driver.constants.js';
import { IracingStatsSyncService } from './iracing-stats-sync.service.js';

const SNAPSHOT = {
  custId: 123,
  name: 'Markus',
  location: 'Germany',
  countryCode: 'DE',
  sportsCarIrating: 3000,
  sportsCarSafetyRating: 'A 4.00',
  refreshToken: 'new-token',
};

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'u1',
    iracingCustomerId: '123',
    iracingStatsSyncedAt: new Date(Date.now() - IRACING_RESYNC_COOLDOWN_MS - 60_000),
    ...overrides,
  };
}

function makeService(profile: ReturnType<typeof makeProfile>, refreshResult: unknown = SNAPSHOT) {
  const driversService = {
    findByIdOrThrow: vi.fn().mockResolvedValue(profile),
    findByUserIdOrThrow: vi.fn().mockResolvedValue({ ...profile, sportsCarIrating: 3000 }),
    findByUserIdWithRefreshToken: vi.fn().mockResolvedValue({ ...profile, iracingRefreshToken: 'old-token' }),
    clearIracingRefreshToken: vi.fn().mockResolvedValue(undefined),
    applyIracingLink: vi.fn().mockResolvedValue(undefined),
    withDiscordUsernameFor: vi.fn().mockImplementation(async (p) => p),
  };
  const iracingService = { refreshLinkResult: vi.fn().mockResolvedValue(refreshResult) };
  const service = new IracingStatsSyncService(driversService as never, iracingService as never);
  return { service, driversService, iracingService };
}

const self = { id: 'u1', role: Role.MEMBER };
const admin = { id: 'admin', role: Role.ADMIN };

describe('IracingStatsSyncService.resyncDriver', () => {
  it('refreshes via the stored token, applies the snapshot and returns the updated profile', async () => {
    const { service, driversService, iracingService } = makeService(makeProfile());

    const result = await service.resyncDriver('p1', self);

    expect(iracingService.refreshLinkResult).toHaveBeenCalledWith('old-token');
    expect(driversService.applyIracingLink).toHaveBeenCalledWith('u1', SNAPSHOT);
    expect(result.sportsCarIrating).toBe(3000);
  });

  it('lets an admin re-sync someone else', async () => {
    const { service, iracingService } = makeService(makeProfile());
    await service.resyncDriver('p1', admin);
    expect(iracingService.refreshLinkResult).toHaveBeenCalledTimes(1);
  });

  it('forbids re-syncing another member', async () => {
    const { service, iracingService } = makeService(makeProfile());
    await expect(service.resyncDriver('p1', { id: 'someone-else', role: Role.MEMBER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(iracingService.refreshLinkResult).not.toHaveBeenCalled();
  });

  it('is idempotent inside the cooldown: no iRacing call, current profile returned', async () => {
    const { service, iracingService, driversService } = makeService(
      makeProfile({ iracingStatsSyncedAt: new Date(Date.now() - 30_000) }),
    );
    await service.resyncDriver('p1', self);
    expect(iracingService.refreshLinkResult).not.toHaveBeenCalled();
    expect(driversService.findByUserIdOrThrow).toHaveBeenCalled();
  });

  it('collapses concurrent requests for one driver into a single refresh', async () => {
    const { service, iracingService } = makeService(makeProfile());
    await Promise.all([service.resyncDriver('p1', self), service.resyncDriver('p1', admin)]);
    expect(iracingService.refreshLinkResult).toHaveBeenCalledTimes(1);
  });

  it('rejects manual drivers and unlinked profiles', async () => {
    await expect(makeService(makeProfile({ userId: null })).service.resyncDriver('p1', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      makeService(makeProfile({ iracingCustomerId: null })).service.resyncDriver('p1', self),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('asks for a re-link when no refresh token is stored', async () => {
    const { service, driversService, iracingService } = makeService(makeProfile());
    driversService.findByUserIdWithRefreshToken.mockResolvedValue({ iracingRefreshToken: null });
    await expect(service.resyncDriver('p1', self)).rejects.toBeInstanceOf(ConflictException);
    expect(iracingService.refreshLinkResult).not.toHaveBeenCalled();
  });

  it('clears a rejected token and asks for a re-link', async () => {
    const { service, driversService } = makeService(makeProfile(), null);
    await expect(service.resyncDriver('p1', self)).rejects.toBeInstanceOf(ConflictException);
    expect(driversService.clearIracingRefreshToken).toHaveBeenCalledWith('p1');
    expect(driversService.applyIracingLink).not.toHaveBeenCalled();
  });

  it('maps an iRacing outage to 502 without clearing the token', async () => {
    const { service, driversService, iracingService } = makeService(makeProfile());
    iracingService.refreshLinkResult.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.resyncDriver('p1', self)).rejects.toBeInstanceOf(BadGatewayException);
    expect(driversService.clearIracingRefreshToken).not.toHaveBeenCalled();
  });
});
