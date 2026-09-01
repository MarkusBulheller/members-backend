import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriversModule } from '../drivers/drivers.module.js';
import { User } from '../users/user.entity.js';
import { IracingAdminTokenService } from './iracing-admin-token.service.js';
import { IracingCarUsageScannedSubsession } from './iracing-car-usage-scanned-subsession.entity.js';
import { IracingCarUsageStat } from './iracing-car-usage-stat.entity.js';
import { IracingCarUsageSyncService } from './iracing-car-usage-sync.service.js';
import { IracingCarUsageService } from './iracing-car-usage.service.js';
import { IracingCarsService } from './iracing-cars.service.js';
import { IracingCar } from './iracing-car.entity.js';
import { IracingDriverLookupService } from './iracing-driver-lookup.service.js';
import { IracingRaceResultLookupService } from './iracing-race-result-lookup.service.js';
import { IracingSeriesSeason } from './iracing-series-season.entity.js';
import { IracingSeriesService } from './iracing-series.service.js';
import { IracingStatsSyncService } from './iracing-stats-sync.service.js';
import { IracingTeamMember } from './iracing-team-member.entity.js';
import { IracingTeamsService } from './iracing-teams.service.js';
import { IracingTeam } from './iracing-team.entity.js';
import { IracingTracksService } from './iracing-tracks.service.js';
import { IracingTrack } from './iracing-track.entity.js';
import { IracingController } from './iracing.controller.js';
import { IracingService } from './iracing.service.js';

@Module({
  imports: [
    DriversModule,
    TypeOrmModule.forFeature([
      IracingCar,
      IracingTrack,
      IracingSeriesSeason,
      IracingTeam,
      IracingTeamMember,
      IracingCarUsageStat,
      IracingCarUsageScannedSubsession,
      User,
    ]),
  ],
  controllers: [IracingController],
  providers: [
    IracingService,
    IracingCarsService,
    IracingTracksService,
    IracingStatsSyncService,
    IracingSeriesService,
    IracingTeamsService,
    IracingAdminTokenService,
    IracingDriverLookupService,
    IracingRaceResultLookupService,
    IracingCarUsageService,
    IracingCarUsageSyncService,
  ],
  exports: [IracingRaceResultLookupService, IracingCarsService, IracingTracksService, IracingSeriesService],
})
export class IracingModule {}
