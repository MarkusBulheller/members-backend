import { Injectable } from '@nestjs/common';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingRaceResultData, IracingService } from './iracing.service.js';

/** Powers admin-driven race result import (see RaceResultsService). See
 * IracingAdminTokenService for how the access token is obtained. */
@Injectable()
export class IracingRaceResultLookupService {
  constructor(
    private readonly adminTokenService: IracingAdminTokenService,
    private readonly iracingService: IracingService,
  ) {}

  async lookupAsAdmin(adminUserId: string, subsessionId: number, teamId: number): Promise<IracingRaceResultData> {
    const accessToken = await this.adminTokenService.getAccessToken(adminUserId);
    return this.iracingService.fetchRaceResult(accessToken, subsessionId, teamId);
  }
}
