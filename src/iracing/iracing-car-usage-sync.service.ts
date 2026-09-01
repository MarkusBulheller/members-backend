import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingCarUsageService } from './iracing-car-usage.service.js';

/** Hourly car-usage scan for whichever series an admin has opted into tracking (see
 * IracingCarUsageService.setTracked) — one access token is reused across every tracked season in
 * a run, rather than one per season, since it's the same Data API regardless of which series is
 * being scanned. */
@Injectable()
export class IracingCarUsageSyncService {
  private readonly logger = new Logger(IracingCarUsageSyncService.name);

  constructor(
    private readonly carUsageService: IracingCarUsageService,
    private readonly adminTokenService: IracingAdminTokenService,
  ) {}

  @Cron('0 * * * *')
  async scanAll(): Promise<void> {
    const seasons = await this.carUsageService.listTrackedSeasons();
    if (seasons.length === 0) return;

    const accessToken = await this.adminTokenService.getSystemAccessToken();
    if (!accessToken) return; // already logged by getSystemAccessToken()

    this.logger.log(`Scanning car usage for ${seasons.length} tracked series`);
    for (const season of seasons) {
      try {
        await this.carUsageService.scanSeason(season, accessToken);
      } catch (error) {
        this.logger.error(`Car usage scan failed for season ${season.seasonId}: ${(error as Error).message}`);
      }
    }
  }
}
