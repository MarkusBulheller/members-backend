import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { CarTrackSetupsService } from './car-track-setups.service.js';

/** Read-only, member-visible view of the same setups the admin-only CarTrackSetupsController
 * manages — grouped by track instead of by car, for the "Car setups for this track" panel. */
@Controller('tracks/:trackId/setups')
@UseGuards(JwtAuthGuard)
export class TrackCarSetupsController {
  constructor(private readonly setupsService: CarTrackSetupsService) {}

  @Get()
  findByTrack(@Param('trackId', ParseUUIDPipe) trackId: string) {
    return this.setupsService.findByTrack(trackId);
  }
}
