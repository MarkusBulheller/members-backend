import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { normalizeDiscordUsername } from './driver.constants.js';
import { CreateManualDriverDto } from './dto/create-manual-driver.dto.js';
import { UpdateManualDriverDto } from './dto/update-manual-driver.dto.js';
import { DriversService } from './drivers.service.js';

async function errorsFor<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const dto = plainToInstance(cls, plain);
  return (await validate(dto as object)).filter((e) => e.property === 'discordUsername');
}

describe('normalizeDiscordUsername', () => {
  it('trims, strips one leading @ and lower-cases', () => {
    expect(normalizeDiscordUsername('  @Delta2611 ')).toBe('delta2611');
    expect(normalizeDiscordUsername('Foo_Bar.Baz')).toBe('foo_bar.baz');
    expect(normalizeDiscordUsername(42)).toBe(42);
  });
});

describe('discordUsername DTO validation', () => {
  const good = ['delta2611', '@Delta2611', '  delta2611  ', 'ab', 'a_b.c', 'x'.repeat(32), 'A1']; // normalised before validation
  const bad = ['a', '', '@', 'x'.repeat(33), 'has space', 'dash-ed', 'ümlaut', 'delta#1234', '@@delta', 42];

  it('accepts valid usernames on create and update and stores the normalised form', async () => {
    for (const name of good) {
      expect(await errorsFor(CreateManualDriverDto, { displayName: 'G', discordUsername: name })).toEqual([]);
      expect(await errorsFor(UpdateManualDriverDto, { discordUsername: name })).toEqual([]);
    }
    expect(plainToInstance(UpdateManualDriverDto, { discordUsername: ' @Delta2611 ' }).discordUsername).toBe('delta2611');
    expect(plainToInstance(CreateManualDriverDto, { displayName: 'G', discordUsername: '@DELTA' }).discordUsername).toBe(
      'delta',
    );
  });

  it('rejects everything else', async () => {
    for (const name of bad) {
      expect(await errorsFor(CreateManualDriverDto, { displayName: 'G', discordUsername: name })).not.toEqual([]);
      expect(await errorsFor(UpdateManualDriverDto, { discordUsername: name })).not.toEqual([]);
    }
  });

  it('is optional, and null clears it on update only', async () => {
    expect(await errorsFor(CreateManualDriverDto, { displayName: 'G' })).toEqual([]);
    expect(await errorsFor(UpdateManualDriverDto, {})).toEqual([]);
    expect(await errorsFor(UpdateManualDriverDto, { discordUsername: null })).toEqual([]);
  });
});

/** Repos mocked just enough: profiles.findOne dispatches on the where clause, the raw read of the
 * stored username and the users query builder are configurable. */
function makeService(
  opts: {
    storedUsername?: string | null;
    profileWithUsername?: { id: string } | null;
    memberWithUsername?: boolean;
    boundProfile?: Record<string, unknown> | null;
    candidate?: Record<string, unknown> | null;
    updateResult?: { affected: number } | Error;
    target?: Record<string, unknown>;
  } = {},
) {
  const target = opts.target ?? { id: 'p1', userId: null, maxSuccessiveStints: null };
  const rawQb = {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    getRawOne: vi.fn().mockResolvedValue({ discordUsername: opts.storedUsername ?? null }),
  };
  const profiles = {
    findOne: vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if ('discordUsername' in where && 'discordId' in where) return opts.candidate ?? null; // binding lookup (b)
      if ('discordUsername' in where) return opts.profileWithUsername ?? null; // duplicate check
      if ('discordId' in where) return opts.boundProfile ?? null; // lookup (a)
      return target;
    }),
    create: vi.fn((v: unknown) => ({ ...(v as object) })),
    save: vi.fn().mockImplementation(async (p: unknown) => p),
    update: vi.fn().mockImplementation(async () => {
      if (opts.updateResult instanceof Error) throw opts.updateResult;
      return opts.updateResult ?? { affected: 1 };
    }),
    createQueryBuilder: vi.fn().mockReturnValue(rawQb),
  };
  const usersQb = {
    where: vi.fn().mockReturnThis(),
    getExists: vi.fn().mockResolvedValue(opts.memberWithUsername ?? false),
  };
  const users = { findOne: vi.fn().mockResolvedValue(null), createQueryBuilder: vi.fn().mockReturnValue(usersQb) };
  return { service: new DriversService(profiles as never, users as never), profiles, users, usersQb };
}

describe('manual driver Discord username: create / update', () => {
  it('creates a guest with a free (normalised) username', async () => {
    const { service, profiles } = makeService();
    await service.createManualDriver({ displayName: 'Guest', discordUsername: '@Delta2611' } as never);
    expect(profiles.save).toHaveBeenCalledWith(expect.objectContaining({ discordUsername: 'delta2611', userId: null }));
  });

  it('409s when another driver profile already has the username', async () => {
    const { service, profiles } = makeService({ profileWithUsername: { id: 'other' } });
    await expect(service.createManualDriver({ displayName: 'G', discordUsername: 'delta2611' } as never)).rejects.toThrow(
      'already assigned to another driver',
    );
    expect(profiles.save).not.toHaveBeenCalled();
  });

  it("409s when it is a portal member's username (compared case-insensitively)", async () => {
    const { service, usersQb } = makeService({ memberWithUsername: true });
    await expect(service.createManualDriver({ displayName: 'G', discordUsername: 'Delta2611' } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(usersQb.where).toHaveBeenCalledWith('LOWER(user.discordUsername) = :username', { username: 'delta2611' });
    await expect(service.updateManualDriver('p1', { discordUsername: 'delta2611' })).rejects.toThrow('portal member');
  });

  it('rejects an invalid username that bypassed the DTO', async () => {
    const { service } = makeService();
    await expect(service.updateManualDriver('p1', { discordUsername: 'a b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("allows re-saving the profile's own username without a duplicate check or clearing the binding", async () => {
    const { service, profiles, users } = makeService({ storedUsername: 'delta2611', profileWithUsername: { id: 'p1' } });
    const saved = await service.updateManualDriver('p1', { discordUsername: '@Delta2611' });
    expect(saved).toMatchObject({ discordUsername: 'delta2611' });
    expect(profiles.update).not.toHaveBeenCalled();
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('clears the bound Discord id when the username changes, and when it is cleared', async () => {
    const changed = makeService({ storedUsername: 'old_name' });
    await changed.service.updateManualDriver('p1', { discordUsername: 'new_name' });
    expect(changed.profiles.update).toHaveBeenCalledWith('p1', { discordId: null });
    expect(changed.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ discordUsername: 'new_name' }));

    const cleared = makeService({ storedUsername: 'old_name' });
    const result = await cleared.service.updateManualDriver('p1', { discordUsername: null });
    expect(cleared.profiles.update).toHaveBeenCalledWith('p1', { discordId: null });
    expect(result.discordUsername).toBeNull();
  });

  it('leaves the username and the binding alone when the field is omitted', async () => {
    const { service, profiles } = makeService({ storedUsername: 'delta2611' });
    const result = await service.updateManualDriver('p1', { bio: 'x' });
    expect('discordUsername' in result).toBe(false);
    expect(profiles.update).not.toHaveBeenCalled();
  });
});

describe('withDiscordUsernameFor for manual drivers', () => {
  it('shows a guest username to admins only', async () => {
    const { service } = makeService({ storedUsername: 'delta2611' });
    const asAdmin = await service.withDiscordUsernameFor({ id: 'p1', userId: null } as never, { id: 'a', role: Role.ADMIN });
    expect(asAdmin.discordUsername).toBe('delta2611');
    const asMember = await service.withDiscordUsernameFor({ id: 'p1', userId: null } as never, { id: 'u', role: Role.MEMBER });
    expect(asMember.discordUsername).toBeNull();
  });

  it('never exposes the bound id', async () => {
    const { service } = makeService({ storedUsername: 'delta2611' });
    const asAdmin = await service.withDiscordUsernameFor({ id: 'p1', userId: null } as never, { id: 'a', role: Role.ADMIN });
    expect('discordId' in asAdmin).toBe(false);
  });
});

describe('findGuestByDiscordIdentity', () => {
  const SNOWFLAKE = '123456789012345678';

  it('(a) returns the manual driver already bound to this Discord id, without touching anything', async () => {
    const bound = { id: 'p1', userId: null };
    const { service, profiles } = makeService({ boundProfile: bound, candidate: { id: 'p2' } });
    await expect(service.findGuestByDiscordIdentity(SNOWFLAKE, 'Delta2611')).resolves.toBe(bound);
    expect(profiles.update).not.toHaveBeenCalled();
    expect(profiles.findOne).toHaveBeenCalledTimes(1);
    expect(profiles.findOne.mock.calls[0][0].where).toMatchObject({ discordId: SNOWFLAKE });
  });

  it('(b) binds an unbound username match on first sight (case-insensitive) and returns it', async () => {
    const candidate = { id: 'p2', userId: null, displayName: 'Delta' };
    const { service, profiles } = makeService({ candidate });
    await expect(service.findGuestByDiscordIdentity(SNOWFLAKE, '@Delta2611')).resolves.toBe(candidate);
    expect(profiles.findOne.mock.calls[1][0].where).toMatchObject({ discordUsername: 'delta2611' });
    expect(profiles.update).toHaveBeenCalledTimes(1);
    expect(profiles.update.mock.calls[0][0]).toMatchObject({ id: 'p2' });
    expect(profiles.update.mock.calls[0][1]).toEqual({ discordId: SNOWFLAKE });
    expect('discordId' in candidate).toBe(false);
  });

  it('only matches unbound profiles, so a profile bound to a different id is never hijacked', async () => {
    // The username lookup filters on discord_id IS NULL, so the DB returns nothing for a bound profile.
    const { service, profiles } = makeService({ candidate: null });
    await expect(service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611')).resolves.toBeNull();
    const usernameWhere = profiles.findOne.mock.calls[1][0].where as Record<string, unknown>;
    expect(usernameWhere).toHaveProperty('discordId'); // IsNull() guard present
    expect(usernameWhere).toHaveProperty('userId');
    expect(profiles.update).not.toHaveBeenCalled();
  });

  it('(b) loses gracefully when the conditional bind affects no row or the unique index clashes', async () => {
    const raced = makeService({ candidate: { id: 'p2' }, updateResult: { affected: 0 } });
    await expect(raced.service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611')).resolves.toBeNull();

    const clash = makeService({
      candidate: { id: 'p2' },
      updateResult: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    await expect(clash.service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611')).resolves.toBeNull();

    const other = makeService({ candidate: { id: 'p2' }, updateResult: new Error('db down') });
    await expect(other.service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611')).rejects.toThrow('db down');
  });

  it('(c) returns null for no username, an unusable username, or no match', async () => {
    const none = makeService();
    await expect(none.service.findGuestByDiscordIdentity(SNOWFLAKE, null)).resolves.toBeNull();
    await expect(none.service.findGuestByDiscordIdentity(SNOWFLAKE, 'not valid!')).resolves.toBeNull();
    await expect(none.service.findGuestByDiscordIdentity(SNOWFLAKE, 'nobody')).resolves.toBeNull();
    expect(none.profiles.update).not.toHaveBeenCalled();
  });

  it('is idempotent: once bound, the next call is answered by lookup (a)', async () => {
    const candidate = { id: 'p2', userId: null };
    const first = makeService({ candidate });
    await first.service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611');
    const second = makeService({ boundProfile: candidate });
    await expect(second.service.findGuestByDiscordIdentity(SNOWFLAKE, 'delta2611')).resolves.toBe(candidate);
    expect(second.profiles.update).not.toHaveBeenCalled();
  });

  it('findGuestByDiscordId is the id-only wrapper (never binds)', async () => {
    const { service, profiles } = makeService({ candidate: { id: 'p2' } });
    await expect(service.findGuestByDiscordId(SNOWFLAKE)).resolves.toBeNull();
    expect(profiles.update).not.toHaveBeenCalled();
  });
});
