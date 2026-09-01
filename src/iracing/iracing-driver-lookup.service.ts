import { Injectable } from '@nestjs/common';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingLinkResult, IracingService } from './iracing.service.js';

/** Powers admin-driven driver search (see DriversController's manual-driver flow). See
 * IracingAdminTokenService for how the access token is obtained. */
@Injectable()
export class IracingDriverLookupService {
  constructor(
    private readonly adminTokenService: IracingAdminTokenService,
    private readonly iracingService: IracingService,
  ) {}

  async searchAsAdmin(adminUserId: string, searchTerm: string): Promise<IracingLinkResult[]> {
    const trimmed = searchTerm.trim();
    if (trimmed.length < 2) return [];

    const accessToken = await this.adminTokenService.getAccessToken(adminUserId);
    return this.iracingService.searchDrivers(accessToken, trimmed);
  }
}
