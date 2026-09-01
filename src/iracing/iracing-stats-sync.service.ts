import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DriversService } from '../drivers/drivers.service.js';
import { IracingService } from './iracing.service.js';

/** Silently refreshes every linked member's Sports Car iRating/safety rating/location once a
 * week, using the single-use refresh token captured at link time — no user interaction needed.
 * A member whose refresh token gets rejected (revoked/expired from inactivity) just stops
 * auto-updating until they click "Re-link" again; see DriversService.clearIracingRefreshToken. */
@Injectable()
export class IracingStatsSyncService {
  private readonly logger = new Logger(IracingStatsSyncService.name);

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
        const result = await this.iracingService.refreshLinkResult(profile.iracingRefreshToken!);
        if (!result) {
          this.logger.warn(`Refresh token for driver profile ${profile.id} was rejected — clearing it`);
          await this.driversService.clearIracingRefreshToken(profile.id);
          continue;
        }
        await this.driversService.applyIracingLink(profile.userId, result);
      } catch (error) {
        this.logger.error(`Failed to refresh driver profile ${profile.id}: ${(error as Error).message}`);
      }
    }
  }
}
