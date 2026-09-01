import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { StatsService } from './stats.service.js';

@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('dashboard')
  getDashboard(
    @Query('year') year?: string,
    @Query('trackId') trackId?: string,
    @Query('carId') carId?: string,
    @Query('series') series?: string,
    @Query('raceLength') raceLength?: string,
  ) {
    return this.statsService.getDashboard({
      year: year ? Number(year) : null,
      trackId: trackId || null,
      carId: carId || null,
      series: series || null,
      raceLength: raceLength || null,
    });
  }
}
