import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile } from './driver-profile.entity.js';
import { CreateManualDriverDto } from './dto/create-manual-driver.dto.js';
import { UpdateDriverProfileDto } from './dto/update-driver-profile.dto.js';
import { UpdateManualDriverDto } from './dto/update-manual-driver.dto.js';

const DRIVER_RELATIONS = { awards: { tier: { definition: true } } } as const;

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
  constructor(
    @InjectRepository(DriverProfile)
    private readonly driverProfilesRepository: Repository<DriverProfile>,
  ) {}

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
    const profile = this.driverProfilesRepository.create({
      userId: null,
      displayName: dto.displayName,
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

    Object.assign(profile, {
      ...(dto.displayName !== undefined && { displayName: dto.displayName }),
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

  findAll(): Promise<DriverProfile[]> {
    return this.driverProfilesRepository.find({
      relations: DRIVER_RELATIONS,
      order: { displayName: 'ASC' },
    });
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
