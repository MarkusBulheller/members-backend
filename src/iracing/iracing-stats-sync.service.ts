import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Role } from '../common/enums/role.enum.js';
import { IRACING_RESYNC_COOLDOWN_MS } from '../drivers/driver.constants.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { DriversService } from '../drivers/drivers.service.js';
import type { User } from '../users/user.entity.js';
import { IracingService } from './iracing.service.js';

/** Silently refreshes every linked member's Sports Car iRating/safety rating/location once a
 * week, using the single-use refresh token captured at link time — no user interaction needed.
 * A member whose refresh token gets rejected (revoked/expired from inactivity) just stops
 * auto-updating until they click "Re-link" again; see DriversService.clearIracingRefreshToken.
 * The same refresh path also powers the on-demand "Re-sync now" button (see resyncDriver). */
@Injectable()
export class IracingStatsSyncService {
  private readonly logger = new Logger(IracingStatsSyncService.name);

  /** Profile ids with a refresh currently running — iRacing refresh tokens are single-use, so two
   * overlapping refreshes of the same profile (a double click, or admin + member at once) would
   * make the second one burn an already-spent token and wrongly clear it. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly driversService: DriversService,
    private readonly iracingService: IracingService,
  ) {}

  /** Monday 03:00 server time — arbitrary off-peak slot, not tied to any iRacing schedule. */
  @Cron('0 3 * * 1')
  async syncAll(): Promise<void> {
    const profiles = await this.driversService.findAllWithIracingRefreshToken();
    this.logger.log(`Refreshing iRacing stats for ${profiles.length} linked profile(s)`);

    for (const profile of profiles) {
      // Manually-added (unlinked) drivers never get a refresh token stored in the first place —
      // this guard is just to satisfy userId's nullable type, not a real runtime case.
      if (!profile.userId) continue;

      try {
        const refreshed = await this.refreshProfile(profile.id, profile.userId, profile.iracingRefreshToken!);
        if (!refreshed) {
          this.logger.warn(`Refresh token for driver profile ${profile.id} was rejected — cleared it`);
        }
      } catch (error) {
        this.logger.error(`Failed to refresh driver profile ${profile.id}: ${(error as Error).message}`);
      }
    }
  }

  /** On-demand version of the weekly refresh for one driver ("Re-sync now" on the profile page).
   * Allowed for the driver themselves and for admins.
   *
   * Idempotent / rate-limited: if the driver's stats were synced less than
   * IRACING_RESYNC_COOLDOWN_MS ago (by the cron, a re-link or an earlier click) no iRacing call is
   * made and the current profile is returned as-is, and concurrent calls for the same driver share
   * one refresh. Returns the full, up-to-date profile. */
  async resyncDriver(profileId: string, viewer: Pick<User, 'id' | 'role'>): Promise<DriverProfile> {
    const profile = await this.driversService.findByIdOrThrow(profileId);

    if (viewer.role !== Role.ADMIN && profile.userId !== viewer.id) {
      throw new ForbiddenException('You can only re-sync your own iRacing stats.');
    }
    if (profile.userId === null) {
      throw new ConflictException(
        "Manually added drivers don't auto-update — re-pick them via Edit to refresh their iRacing stats.",
      );
    }
    if (!profile.iracingCustomerId) {
      throw new BadRequestException('This driver has not linked an iRacing account yet.');
    }

    const recentlySynced =
      profile.iracingStatsSyncedAt !== null &&
      Date.now() - new Date(profile.iracingStatsSyncedAt).getTime() < IRACING_RESYNC_COOLDOWN_MS;

    if (!recentlySynced) {
      await this.refreshOnce(profile.id, profile.userId);
    }

    const fresh = await this.driversService.findByUserIdOrThrow(profile.userId);
    return this.driversService.withDiscordUsernameFor(fresh, viewer);
  }

  private refreshOnce(profileId: string, userId: string): Promise<void> {
    const running = this.inFlight.get(profileId);
    if (running) return running;

    const run = (async () => {
      const withToken = await this.driversService.findByUserIdWithRefreshToken(userId);
      if (!withToken?.iracingRefreshToken) {
        throw new ConflictException(
          'Automatic syncing is not set up for this iRacing account — it needs to be re-linked first.',
        );
      }

      let refreshed: boolean;
      try {
        refreshed = await this.refreshProfile(profileId, userId, withToken.iracingRefreshToken);
      } catch (error) {
        this.logger.error(`Manual iRacing re-sync failed for driver profile ${profileId}: ${(error as Error).message}`);
        throw new BadGatewayException('Could not reach iRacing to refresh the stats — try again in a few minutes.');
      }
      if (!refreshed) {
        throw new ConflictException('iRacing no longer accepts the saved sign-in — the account needs to be re-linked.');
      }
    })().finally(() => this.inFlight.delete(profileId));

    this.inFlight.set(profileId, run);
    return run;
  }

  /** Trades the stored refresh token for a fresh snapshot and applies it. Returns false (after
   * clearing the dead token) if iRacing rejected the token; throws if iRacing could not be reached. */
  private async refreshProfile(profileId: string, userId: string, refreshToken: string): Promise<boolean> {
    const result = await this.iracingService.refreshLinkResult(refreshToken);
    if (!result) {
      await this.driversService.clearIracingRefreshToken(profileId);
      return false;
    }
    await this.driversService.applyIracingLink(userId, result);
    return true;
  }
}
