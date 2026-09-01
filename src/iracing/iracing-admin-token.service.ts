import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../common/enums/role.enum.js';
import { DriversService } from '../drivers/drivers.service.js';
import { User } from '../users/user.entity.js';
import { IracingService } from './iracing.service.js';

/** Shared by every "admin does an ad-hoc Data API lookup" feature (driver search, race result
 * import) — reuses the requesting admin's own stored iRacing refresh token instead of a fresh
 * OAuth redirect per action, since those features need repeated/on-demand calls rather than one
 * bulk sync. Requires the admin to have linked their own iRacing account first. */
@Injectable()
export class IracingAdminTokenService {
  private readonly logger = new Logger(IracingAdminTokenService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly driversService: DriversService,
    private readonly iracingService: IracingService,
  ) {}

  async getAccessToken(adminUserId: string): Promise<string> {
    const adminProfile = await this.driversService.findByUserIdWithRefreshToken(adminUserId);
    if (!adminProfile?.iracingRefreshToken) {
      throw new BadRequestException(
        'Link your own iRacing account first (Edit Profile → Link iRacing Account) to use this feature.',
      );
    }

    const tokens = await this.iracingService.refreshAccessToken(adminProfile.iracingRefreshToken);
    if (!tokens) {
      await this.driversService.clearIracingRefreshToken(adminProfile.id);
      throw new BadRequestException(
        'Your iRacing link has expired — re-link your account (Edit Profile) and try again.',
      );
    }

    // Refresh tokens are single-use — persist the rotated one immediately so the admin's own
    // weekly auto-refresh and any later use of this feature keep working.
    await this.driversService.setIracingRefreshToken(adminProfile.id, tokens.refreshToken);

    return tokens.accessToken;
  }

  /** For background jobs with no requesting admin to attribute the call to (see
   * IracingCarUsageSyncService) — tries each admin's own linked account in turn until one has a
   * working refresh token, since the Data API calls involved aren't tied to any one person's
   * identity anyway. Returns null (rather than throwing) if no admin has a usable link, so the
   * caller can just skip this run and log it. */
  async getSystemAccessToken(): Promise<string | null> {
    const admins = await this.usersRepository.find({ where: { role: Role.ADMIN } });
    for (const admin of admins) {
      const profile = await this.driversService.findByUserIdWithRefreshToken(admin.id);
      if (!profile?.iracingRefreshToken) continue;

      const tokens = await this.iracingService.refreshAccessToken(profile.iracingRefreshToken);
      if (!tokens) {
        await this.driversService.clearIracingRefreshToken(profile.id);
        continue;
      }
      await this.driversService.setIracingRefreshToken(profile.id, tokens.refreshToken);
      return tokens.accessToken;
    }

    this.logger.warn('No admin has a working iRacing link — skipping this run.');
    return null;
  }
}
