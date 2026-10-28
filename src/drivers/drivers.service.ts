import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IsNull, Repository } from 'typeorm';
import { AchievementAward } from '../achievements/achievement-award.entity.js';
import { Role } from '../common/enums/role.enum.js';
import { User } from '../users/user.entity.js';
import { AVATARS_UPLOAD_DIR } from './avatar-multer.config.js';
import { DISCORD_USERNAME_PATTERN, MAX_SUCCESSIVE_STINTS_CAP, normalizeDiscordUsername } from './driver.constants.js';
import { DriverProfile } from './driver-profile.entity.js';
import { CreateManualDriverDto } from './dto/create-manual-driver.dto.js';
import { UpdateDriverProfileDto } from './dto/update-driver-profile.dto.js';
import { UpdateManualDriverDto } from './dto/update-manual-driver.dto.js';

const DRIVER_RELATIONS = { awards: { tier: { definition: true } } } as const;

const DISCORD_AVATAR_HOST = 'cdn.discordapp.com';
const DISCORD_AVATAR_MAX_BYTES = 3 * 1024 * 1024;
const AVATAR_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/** A driver as returned by GET /drivers: the profile without its awards tree, plus how many awards it has. */
export type DriverListItem = Omit<DriverProfile, 'awards'> & { awardCount: number };

export interface IracingSnapshot {
  custId: number;
  name: string;
  location: string | null;
  countryCode: string | null;
  sportsCarIrating: number | null;
  sportsCarSafetyRating: string | null;
  refreshToken: string | null;
}

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /** The UI caps "Max stints in a row" at MAX_SUCCESSIVE_STINTS_CAP, but rows saved before that cap
   * existed may hold a larger value. The form always re-submits every field, so a plain DTO @Max
   * would make such a profile impossible to save. Instead a value above the cap is only rejected
   * when it is a *change* — re-submitting the stored value is fine. null (clear) is always fine. */
  private assertMaxStintsAllowed(next: number | null | undefined, current: number | null): void {
    if (next === undefined || next === null) return;
    if (next > MAX_SUCCESSIVE_STINTS_CAP && next !== current) {
      throw new BadRequestException(`maxSuccessiveStints must not be greater than ${MAX_SUCCESSIVE_STINTS_CAP}`);
    }
  }

  /** Adds the Discord username to a profile's payload (transient per-request value of the
   * `discordUsername` property). A portal member's handle (users.discord_username) goes to the
   * profile's owner and admins; a manual driver's stored username (admin-set, `select: false`)
   * goes to admins only. Everyone else gets nothing / null. The bound Discord id never leaves the
   * backend. */
  async withDiscordUsernameFor(profile: DriverProfile, viewer: Pick<User, 'id' | 'role'>): Promise<DriverProfile> {
    if (profile.userId === null) {
      profile.discordUsername = viewer.role === Role.ADMIN ? await this.readStoredDiscordUsername(profile.id) : null;
      return profile;
    }
    if (viewer.role !== Role.ADMIN && viewer.id !== profile.userId) {
      return profile;
    }
    const owner = await this.usersRepository.findOne({ where: { id: profile.userId } });
    profile.discordUsername = owner?.discordUsername ?? null;
    return profile;
  }

  /** A guest's stored username — `select: false`, so read explicitly. */
  private async readStoredDiscordUsername(profileId: string): Promise<string | null> {
    const row = await this.driverProfilesRepository
      .createQueryBuilder('profile')
      .select('profile.discordUsername', 'discordUsername')
      .where('profile.id = :id', { id: profileId })
      .getRawOne<{ discordUsername: string | null }>();
    return row?.discordUsername ?? null;
  }

  /** The guest (manual) driver behind a Discord user, for the Discord signup flow:
   * (a) a manual driver already bound to this Discord id; else
   * (b) a manual driver with a matching username (case-insensitive) that is not bound yet — it is
   *     BOUND to this id right here (conditional UPDATE, so concurrent calls can't double-bind and
   *     a profile bound to someone else is never taken over); else
   * (c) null. A unique-index clash while binding counts as not found. The bound id is never put
   * on the returned object. */
  async findGuestByDiscordIdentity(discordId: string, username: string | null): Promise<DriverProfile | null> {
    const bound = await this.driverProfilesRepository.findOne({ where: { discordId, userId: IsNull() } });
    if (bound) return bound;

    const normalized = normalizeDiscordUsername(username ?? '');
    if (!DISCORD_USERNAME_PATTERN.test(normalized)) return null;
    const candidate = await this.driverProfilesRepository.findOne({
      where: { discordUsername: normalized, discordId: IsNull(), userId: IsNull() },
    });
    if (!candidate) return null;

    try {
      const result = await this.driverProfilesRepository.update({ id: candidate.id, discordId: IsNull() }, { discordId });
      if (!result.affected) return null;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
    return candidate;
  }

  /** Compatibility wrapper: lookup by Discord id only (no username binding). */
  findGuestByDiscordId(discordId: string): Promise<DriverProfile | null> {
    return this.findGuestByDiscordIdentity(discordId, null);
  }

  private assertValidDiscordUsername(username: string): void {
    if (!DISCORD_USERNAME_PATTERN.test(username)) {
      throw new BadRequestException('The Discord username must be 2-32 characters of a-z, 0-9, "_" or "."');
    }
  }

  /** A username may belong to only one driver profile AND must not be a portal member's
   * (members sign up with their own account) — compared case-insensitively on the normalised
   * value; 409 with a message the admin can act on. */
  private async ensureDiscordUsernameAvailable(username: string, ownProfileId?: string): Promise<void> {
    const profile = await this.driverProfilesRepository.findOne({ where: { discordUsername: username } });
    if (profile && profile.id !== ownProfileId) {
      throw new ConflictException('This Discord username is already assigned to another driver');
    }
    const memberExists = await this.usersRepository
      .createQueryBuilder('user')
      .where('LOWER(user.discordUsername) = :username', { username })
      .getExists();
    if (memberExists) {
      throw new ConflictException(
        'This Discord username belongs to a portal member — they sign up with their own account, not as a guest',
      );
    }
  }

  /** Idempotent: a user being re-approved after a suspension already has a profile, so this
   * returns the existing one instead of violating the unique userId constraint. */
  async createProfileForUser(userId: string, defaultDisplayName: string): Promise<DriverProfile> {
    const existing = await this.driverProfilesRepository.findOne({ where: { userId } });
    if (existing) {
      return existing;
    }
    const profile = this.driverProfilesRepository.create({ userId, displayName: defaultDisplayName });
    return this.driverProfilesRepository.save(profile);
  }

  /** Admin-added roster entry with no portal login — see the "New Driver" page. `snapshot` is
   * optional since an admin may add a driver by name only, without picking an iRacing match. */
  async createManualDriver(dto: CreateManualDriverDto): Promise<DriverProfile> {
    const discordUsername = dto.discordUsername ? normalizeDiscordUsername(dto.discordUsername) : null;
    if (discordUsername) {
      this.assertValidDiscordUsername(discordUsername);
      await this.ensureDiscordUsernameAvailable(discordUsername);
    }
    const profile = this.driverProfilesRepository.create({
      userId: null,
      displayName: dto.displayName,
      discordUsername,
      country: dto.country ?? null,
      preferredClasses: dto.preferredClasses ?? null,
      timezone: dto.timezone ?? null,
      bio: dto.bio ?? null,
      maxSuccessiveStints: dto.maxSuccessiveStints ?? null,
      startingDriver: dto.startingDriver ?? false,
      wetDriver: dto.wetDriver ?? false,
      nightDriver: dto.nightDriver ?? false,
    });

    if (dto.iracingCustId !== undefined) {
      await this.ensureIracingIdAvailable(String(dto.iracingCustId));
      this.applySnapshotToProfile(profile, {
        custId: dto.iracingCustId,
        name: dto.iracingName ?? '',
        location: dto.iracingLocation ?? null,
        countryCode: dto.iracingCountryCode ?? null,
        sportsCarIrating: dto.sportsCarIrating ?? null,
        sportsCarSafetyRating: dto.sportsCarSafetyRating ?? null,
        refreshToken: null,
      });
    }

    return this.driverProfilesRepository.save(profile);
  }

  /** Auto-creates a manual (unlinked) driver profile for a race participant who isn't on our
   * roster yet — see RaceResultsService.importFromIracing(). Idempotent by iRacing customer id:
   * if a matching profile already exists (linked or manual), returns it unchanged rather than
   * creating a duplicate. */
  async ensureManualDriverExists(snapshot: IracingSnapshot): Promise<DriverProfile> {
    const custIdString = String(snapshot.custId);
    const existing = await this.driverProfilesRepository.findOne({ where: { iracingCustomerId: custIdString } });
    if (existing) {
      return existing;
    }

    const profile = this.driverProfilesRepository.create({ userId: null, displayName: snapshot.name });
    this.applySnapshotToProfile(profile, snapshot);
    return this.driverProfilesRepository.save(profile);
  }

  /** Edits a manually-added driver's basic fields — real members manage their own profile via
   * updateOwnProfile, never through this admin route (guarded below). */
  async updateManualDriver(id: string, dto: UpdateManualDriverDto): Promise<DriverProfile> {
    const profile = await this.findByIdOrThrow(id);
    this.guardIsManualProfile(profile);
    this.assertMaxStintsAllowed(dto.maxSuccessiveStints, profile.maxSuccessiveStints);
    // Username: validated/duplicate-checked only when it actually changes. A change (or a clear)
    // also drops the bound Discord id — the previous person's identity must not carry over.
    let discordUsernameUpdate: { discordUsername: string | null } | undefined;
    if (dto.discordUsername !== undefined) {
      const next = dto.discordUsername === null ? null : normalizeDiscordUsername(dto.discordUsername);
      const current = await this.readStoredDiscordUsername(profile.id);
      if (next !== current) {
        if (next) {
          this.assertValidDiscordUsername(next);
          await this.ensureDiscordUsernameAvailable(next, profile.id);
        }
        await this.driverProfilesRepository.update(profile.id, { discordId: null });
      }
      discordUsernameUpdate = { discordUsername: next };
    }

    Object.assign(profile, {
      ...(dto.displayName !== undefined && { displayName: dto.displayName }),
      ...discordUsernameUpdate,
      ...(dto.country !== undefined && { country: dto.country }),
      ...(dto.preferredClasses !== undefined && { preferredClasses: dto.preferredClasses }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.bio !== undefined && { bio: dto.bio }),
      ...(dto.maxSuccessiveStints !== undefined && { maxSuccessiveStints: dto.maxSuccessiveStints }),
      ...(dto.startingDriver !== undefined && { startingDriver: dto.startingDriver }),
      ...(dto.wetDriver !== undefined && { wetDriver: dto.wetDriver }),
      ...(dto.nightDriver !== undefined && { nightDriver: dto.nightDriver }),
    });

    return this.driverProfilesRepository.save(profile);
  }

  /** Re-picks (or attaches for the first time) an iRacing identity for a manually-added driver —
   * the admin-search equivalent of a member's own "(Re-)link" button. */
  async applyIracingSnapshotToManualDriver(id: string, snapshot: IracingSnapshot): Promise<DriverProfile> {
    const profile = await this.findByIdOrThrow(id);
    this.guardIsManualProfile(profile);
    await this.guardIracingIdChange(profile, snapshot.custId);
    this.applySnapshotToProfile(profile, snapshot);
    return this.driverProfilesRepository.save(profile);
  }

  private guardIsManualProfile(profile: DriverProfile): void {
    if (profile.userId !== null) {
      throw new ConflictException('This driver is linked to a portal member and manages their own profile.');
    }
  }

  /** Roster list: the profile plus `awardCount` instead of the nested awards -> tier -> definition
   * tree (GET /drivers/:id still returns the full awards). One grouped COUNT query, no row multiplication. */
  async findAll(): Promise<DriverListItem[]> {
    const [profiles, awardCounts] = await Promise.all([
      this.driverProfilesRepository.find({ order: { displayName: 'ASC' } }),
      this.awardCountsByDriver(),
    ]);
    return profiles.map(
      (profile) => Object.assign(profile, { awardCount: awardCounts.get(profile.id) ?? 0 }) as unknown as DriverListItem,
    );
  }

  /** achievement_awards rows per driver profile, one grouped query. Drivers without any are absent. */
  private async awardCountsByDriver(): Promise<Map<string, number>> {
    const rows = await this.driverProfilesRepository.manager
      .createQueryBuilder(AchievementAward, 'award')
      .select('award.driverProfileId', 'driverProfileId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('award.driverProfileId')
      .getRawMany<{ driverProfileId: string; count: string }>();
    return new Map(rows.map((row) => [row.driverProfileId, Number(row.count)]));
  }

  async findByIdOrThrow(id: string): Promise<DriverProfile> {
    const profile = await this.driverProfilesRepository.findOne({
      where: { id },
      relations: DRIVER_RELATIONS,
    });
    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }
    return profile;
  }

  /** Used to link an iRacing result's driver_results entries back to our own roster — see
   * RaceResultsService.importFromIracing(). Returns null (rather than throwing) since most
   * cust_ids in a race result won't belong to any of our drivers. */
  findByIracingCustomerId(iracingCustomerId: string): Promise<DriverProfile | null> {
    return this.driverProfilesRepository.findOne({ where: { iracingCustomerId } });
  }

  async findByUserIdOrThrow(userId: string): Promise<DriverProfile> {
    const profile = await this.driverProfilesRepository.findOne({
      where: { userId },
      relations: DRIVER_RELATIONS,
    });
    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }
    return profile;
  }

  async updateOwnProfile(userId: string, dto: UpdateDriverProfileDto): Promise<DriverProfile> {
    const profile = await this.findByUserIdOrThrow(userId);
    this.assertMaxStintsAllowed(dto.maxSuccessiveStints, profile.maxSuccessiveStints);

    if (dto.iracingCustomerId && dto.iracingCustomerId !== profile.iracingCustomerId) {
      await this.ensureIracingIdAvailable(dto.iracingCustomerId, profile.id);
    }

    Object.assign(profile, dto);
    return this.driverProfilesRepository.save(profile);
  }

  /** Admin override of a linked member's own profile fields (timezone, race preferences, etc.) —
   * same shape and validation as updateOwnProfile, just addressable by id instead of gated to the
   * caller's own userId. Rejects manual (unlinked) profiles since those already have their own
   * admin-edit path (updateManualDriver) with a different field set. */
  async updateProfileAsAdmin(id: string, dto: UpdateDriverProfileDto): Promise<DriverProfile> {
    const profile = await this.findByIdOrThrow(id);
    if (profile.userId === null) {
      throw new ConflictException('This driver is not a portal member — edit them from the driver list instead.');
    }
    this.assertMaxStintsAllowed(dto.maxSuccessiveStints, profile.maxSuccessiveStints);

    if (dto.iracingCustomerId && dto.iracingCustomerId !== profile.iracingCustomerId) {
      await this.ensureIracingIdAvailable(dto.iracingCustomerId, profile.id);
    }

    Object.assign(profile, dto);
    return this.driverProfilesRepository.save(profile);
  }

  /** Applies a verified snapshot from iRacing's OAuth flow (see IracingService) — bypasses
   * UpdateDriverProfileDto since this is system-verified data, not user-submitted input. Used
   * both for a member's manual "(Re-)link" click and for the weekly auto-refresh cron.
   *
   * Handles the "this person was already on the roster" case: a member's profile starts out
   * empty at approval time (see createProfileForUser), with no idea a manually-added profile for
   * the same real person might already exist (added by an admin, or auto-created from a race
   * result import — see ensureManualDriverExists). If this iRacing ID is already claimed by such
   * an *unlinked* profile, that one is absorbed instead of rejecting the link: it already carries
   * this person's real race history and achievements (FK'd by profile id), so it survives —
   * gaining the member's userId — while the freshly-created empty profile, which nothing points
   * to yet, is discarded. A conflict is only a real error when the ID is already claimed by
   * *another member's own* linked profile. */
  async applyIracingLink(userId: string, snapshot: IracingSnapshot): Promise<DriverProfile> {
    const profile = await this.findByUserIdOrThrow(userId);
    const custIdString = String(snapshot.custId);

    if (custIdString !== profile.iracingCustomerId) {
      const claimedBy = await this.driverProfilesRepository.findOne({ where: { iracingCustomerId: custIdString } });
      if (claimedBy && claimedBy.id !== profile.id) {
        if (claimedBy.userId !== null) {
          throw new ConflictException('This iRacing account is already linked to another driver');
        }
        // Delete the empty profile *before* reassigning its userId to claimedBy — userId is
        // unique, so both rows would momentarily hold the same value otherwise and the save
        // below would fail the constraint.
        await this.driverProfilesRepository.remove(profile);
        claimedBy.userId = userId;
        this.applySnapshotToProfile(claimedBy, snapshot);
        return this.driverProfilesRepository.save(claimedBy);
      }
    }

    this.applySnapshotToProfile(profile, snapshot);
    return this.driverProfilesRepository.save(profile);
  }

  async setOwnAvatar(userId: string, file: Express.Multer.File): Promise<DriverProfile> {
    const profile = await this.findByUserIdOrThrow(userId);
    return this.applyAvatarFile(profile, file);
  }

  async removeOwnAvatar(userId: string): Promise<DriverProfile> {
    const profile = await this.findByUserIdOrThrow(userId);
    return this.clearAvatarFile(profile);
  }

  /** Admin equivalent of setOwnAvatar/removeOwnAvatar — works for any driver, manual or linked,
   * matching updateProfileAsAdmin's "admin can do on behalf of" scope. */
  async setAvatarAsAdmin(id: string, file: Express.Multer.File): Promise<DriverProfile> {
    const profile = await this.findByIdOrThrow(id);
    return this.applyAvatarFile(profile, file);
  }

  async removeAvatarAsAdmin(id: string): Promise<DriverProfile> {
    const profile = await this.findByIdOrThrow(id);
    return this.clearAvatarFile(profile);
  }

  /** "Use Discord avatar": copies the image behind the member's cached Discord avatar URL into our
   * own avatar storage, so it goes through exactly the same mechanism (and cleanup) as an uploaded
   * photo and keeps working if their Discord avatar later changes or is removed. */
  async setOwnAvatarFromDiscord(userId: string): Promise<DriverProfile> {
    const profile = await this.findByUserIdOrThrow(userId);
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user?.discordAvatarUrl) {
      throw new BadRequestException('Your Discord account has no custom avatar to use.');
    }

    let url: URL;
    try {
      url = new URL(user.discordAvatarUrl);
    } catch {
      throw new BadRequestException('Your Discord avatar URL is invalid.');
    }
    // Defence in depth: the URL is built by DiscordService from the OAuth response, but never fetch
    // anything other than Discord's own CDN on a user's behalf.
    if (url.protocol !== 'https:' || url.hostname !== DISCORD_AVATAR_HOST) {
      throw new BadRequestException('Your Discord avatar URL is invalid.');
    }
    url.searchParams.set('size', '256');

    let buffer: Buffer;
    let extension: string;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        throw new Error(`Discord CDN responded ${response.status}`);
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const knownExtension = AVATAR_EXTENSIONS[contentType];
      if (!knownExtension) {
        throw new Error(`Unexpected content type "${contentType}"`);
      }
      extension = knownExtension;
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      this.logger.warn(`Could not download Discord avatar for user ${userId}: ${(error as Error).message}`);
      throw new BadGatewayException('Could not download your Discord avatar — try again later.');
    }
    if (buffer.length === 0 || buffer.length > DISCORD_AVATAR_MAX_BYTES) {
      throw new BadGatewayException('Could not download your Discord avatar — try again later.');
    }

    const filename = `${randomUUID()}${extension}`;
    await mkdir(AVATARS_UPLOAD_DIR, { recursive: true });
    await writeFile(join(AVATARS_UPLOAD_DIR, filename), buffer);
    return this.applyAvatarFilename(profile, filename);
  }

  private applyAvatarFile(profile: DriverProfile, file: Express.Multer.File): Promise<DriverProfile> {
    return this.applyAvatarFilename(profile, file.filename);
  }

  private async applyAvatarFilename(profile: DriverProfile, filename: string): Promise<DriverProfile> {
    await this.deleteAvatarFileIfPresent(profile.avatarUrl);
    profile.avatarUrl = `/uploads/avatars/${filename}`;
    return this.driverProfilesRepository.save(profile);
  }

  private async clearAvatarFile(profile: DriverProfile): Promise<DriverProfile> {
    await this.deleteAvatarFileIfPresent(profile.avatarUrl);
    profile.avatarUrl = null;
    return this.driverProfilesRepository.save(profile);
  }

  /** Avatar is a single mutable slot (unlike Livery's many-per-car list), so every set/clear
   * cleans up whatever file was there before it — otherwise old uploads would just accumulate on
   * disk forever. */
  private async deleteAvatarFileIfPresent(avatarUrl: string | null): Promise<void> {
    if (!avatarUrl) return;
    const filename = avatarUrl.split('/').pop();
    if (!filename) return;
    try {
      await unlink(join(AVATARS_UPLOAD_DIR, filename));
    } catch (error) {
      this.logger.warn(`Could not delete avatar file "${filename}": ${(error as Error).message}`);
    }
  }

  private applySnapshotToProfile(profile: DriverProfile, snapshot: IracingSnapshot): void {
    profile.iracingCustomerId = String(snapshot.custId);
    profile.iracingName = snapshot.name;
    profile.iracingLocation = snapshot.location;
    profile.iracingCountryCode = snapshot.countryCode;
    profile.sportsCarIrating = snapshot.sportsCarIrating;
    profile.sportsCarSafetyRating = snapshot.sportsCarSafetyRating;
    profile.iracingRefreshToken = snapshot.refreshToken;
    profile.iracingStatsSyncedAt = new Date();
  }

  private async guardIracingIdChange(profile: DriverProfile, custId: number): Promise<void> {
    const custIdString = String(custId);
    if (custIdString !== profile.iracingCustomerId) {
      await this.ensureIracingIdAvailable(custIdString, profile.id);
    }
  }

  /** `iracingRefreshToken` is `select: false` on the entity, so it's excluded from every normal
   * query by default (including anything returned to the frontend) — this explicitly opts back
   * in for the weekly auto-refresh cron only. See IracingStatsSyncService. */
  findAllWithIracingRefreshToken(): Promise<DriverProfile[]> {
    return this.driverProfilesRepository
      .createQueryBuilder('profile')
      .addSelect('profile.iracingRefreshToken')
      .where('profile.iracingRefreshToken IS NOT NULL')
      .getMany();
  }

  /** Same `select: false` opt-in as findAllWithIracingRefreshToken(), for one specific user —
   * used by IracingDriverLookupService to power admin-driven driver search using the admin's
   * own stored refresh token instead of a fresh OAuth round-trip per search. */
  findByUserIdWithRefreshToken(userId: string): Promise<DriverProfile | null> {
    return this.driverProfilesRepository
      .createQueryBuilder('profile')
      .addSelect('profile.iracingRefreshToken')
      .where('profile.userId = :userId', { userId })
      .getOne();
  }

  /** Called when a stored refresh token is rejected by iRacing (revoked/expired from
   * inactivity) — this app's signal that the member needs to click "Re-link" again. */
  async clearIracingRefreshToken(profileId: string): Promise<void> {
    await this.setIracingRefreshToken(profileId, null);
  }

  async setIracingRefreshToken(profileId: string, token: string | null): Promise<void> {
    await this.driverProfilesRepository.update(profileId, { iracingRefreshToken: token });
  }

  private async ensureIracingIdAvailable(iracingCustomerId: string, ownProfileId?: string): Promise<void> {
    const claimedBy = await this.driverProfilesRepository.findOne({ where: { iracingCustomerId } });
    if (claimedBy && claimedBy.id !== ownProfileId) {
      throw new ConflictException('This iRacing account is already linked to another driver');
    }
  }

}
