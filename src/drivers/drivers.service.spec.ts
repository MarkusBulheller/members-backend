import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Role } from '../common/enums/role.enum.js';
import { DriversService } from './drivers.service.js';

function makeService(profile: Record<string, unknown>, user: Record<string, unknown> | null = null) {
  const profiles = {
    findOne: vi.fn().mockResolvedValue(profile),
    save: vi.fn().mockImplementation(async (p) => p),
  };
  const users = { findOne: vi.fn().mockResolvedValue(user) };
  const service = new DriversService(profiles as never, users as never);
  return { service, profiles, users };
}

describe('maxSuccessiveStints cap', () => {
  it('rejects a change above 6', async () => {
    const { service } = makeService({ id: 'p1', userId: 'u1', maxSuccessiveStints: 3 });
    await expect(service.updateOwnProfile('u1', { maxSuccessiveStints: 7 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts 6, null and re-submitting an existing legacy value above 6', async () => {
    const six = makeService({ id: 'p1', userId: 'u1', maxSuccessiveStints: 3 });
    await expect(six.service.updateOwnProfile('u1', { maxSuccessiveStints: 6 })).resolves.toBeDefined();

    const cleared = makeService({ id: 'p1', userId: 'u1', maxSuccessiveStints: 3 });
    await expect(cleared.service.updateOwnProfile('u1', { maxSuccessiveStints: null })).resolves.toBeDefined();

    const legacy = makeService({ id: 'p1', userId: 'u1', maxSuccessiveStints: 9 });
    await expect(legacy.service.updateOwnProfile('u1', { maxSuccessiveStints: 9 })).resolves.toBeDefined();
    await expect(legacy.service.updateOwnProfile('u1', { maxSuccessiveStints: 10 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('applies to admin edits and manual drivers too', async () => {
    const admin = makeService({ id: 'p1', userId: 'u1', maxSuccessiveStints: null });
    await expect(admin.service.updateProfileAsAdmin('p1', { maxSuccessiveStints: 8 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const manual = makeService({ id: 'p2', userId: null, maxSuccessiveStints: null });
    await expect(manual.service.updateManualDriver('p2', { maxSuccessiveStints: 8 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('withDiscordUsernameFor', () => {
  const user = { id: 'u1', discordUsername: 'markus' };

  it('adds the handle for the owner and for admins', async () => {
    const { service } = makeService({}, user);
    const own = await service.withDiscordUsernameFor({ userId: 'u1' } as never, { id: 'u1', role: Role.MEMBER });
    expect(own.discordUsername).toBe('markus');
    const asAdmin = await service.withDiscordUsernameFor({ userId: 'u1' } as never, { id: 'a', role: Role.ADMIN });
    expect(asAdmin.discordUsername).toBe('markus');
  });

  it('omits it for other members and nulls it for manual drivers', async () => {
    const { service, users } = makeService({}, user);
    const other = await service.withDiscordUsernameFor({ userId: 'u1' } as never, { id: 'u2', role: Role.MEMBER });
    expect(other.discordUsername).toBeUndefined();
    expect(users.findOne).not.toHaveBeenCalled();
    const manual = await service.withDiscordUsernameFor({ userId: null } as never, { id: 'u2', role: Role.MEMBER });
    expect(manual.discordUsername).toBeNull();
  });
});

describe('setOwnAvatarFromDiscord', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(writeFile).mockClear();
    vi.mocked(mkdir).mockClear();
    vi.mocked(unlink).mockClear();
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const imageResponse = (type = 'image/png', bytes = 10) =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

  it('downloads the Discord CDN image into avatar storage and sets avatarUrl, replacing the old file', async () => {
    const { service, profiles } = makeService(
      { id: 'p1', userId: 'u1', avatarUrl: '/uploads/avatars/old.png' },
      { id: 'u1', discordAvatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
    );
    fetchMock.mockResolvedValue(imageResponse());

    const result = await service.setOwnAvatarFromDiscord('u1');

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cdn.discordapp.com/avatars/1/abc.png?size=256');
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(result.avatarUrl).toMatch(/^\/uploads\/avatars\/[0-9a-f-]+\.png$/);
    expect(profiles.save).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('rejects when the user has no Discord avatar or a non-Discord URL, without fetching', async () => {
    const none = makeService({ id: 'p1', userId: 'u1' }, { id: 'u1', discordAvatarUrl: null });
    await expect(none.service.setOwnAvatarFromDiscord('u1')).rejects.toBeInstanceOf(BadRequestException);

    const evil = makeService({ id: 'p1', userId: 'u1' }, { id: 'u1', discordAvatarUrl: 'https://evil.example/a.png' });
    await expect(evil.service.setOwnAvatarFromDiscord('u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps CDN failures and non-image responses to 502 and writes nothing', async () => {
    const { service } = makeService(
      { id: 'p1', userId: 'u1' },
      { id: 'u1', discordAvatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
    );
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(service.setOwnAvatarFromDiscord('u1')).rejects.toBeInstanceOf(BadGatewayException);
    fetchMock.mockResolvedValueOnce(imageResponse('text/html'));
    await expect(service.setOwnAvatarFromDiscord('u1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('findAll (roster list)', () => {
  function makeListService(rows: Record<string, unknown>[], countRows: Record<string, unknown>[]) {
    const qb: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ['select', 'addSelect', 'groupBy']) {
      qb[name] = vi.fn().mockReturnValue(qb);
    }
    qb.getRawMany = vi.fn().mockResolvedValue(countRows);
    const profiles = {
      find: vi.fn().mockResolvedValue(rows),
      manager: { createQueryBuilder: vi.fn().mockReturnValue(qb) },
    };
    const service = new DriversService(profiles as never, {} as never);
    return { service, profiles, qb };
  }

  it('returns awardCount from one grouped query and never loads the awards tree', async () => {
    const { service, profiles, qb } = makeListService(
      [{ id: 'p1', displayName: 'A' }, { id: 'p2', displayName: 'B' }],
      [{ driverProfileId: 'p1', count: '3' }],
    );

    const list = await service.findAll();

    expect(profiles.find).toHaveBeenCalledWith({ order: { displayName: 'ASC' } });
    expect(profiles.manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.groupBy).toHaveBeenCalledWith('award.driverProfileId');
    expect(list.map((d) => d.awardCount)).toEqual([3, 0]);
    expect(list[0]).not.toHaveProperty('awards');
  });
});
