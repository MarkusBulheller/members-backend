import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RecapService } from './recap.service.js';
import { StatsService } from './stats.service.js';

@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly recapService: RecapService,
  ) {}

  /** Team season recap. `year` defaults to the current year (or the latest with results); `teamId`
   * (optional, any sign) narrows to one iRacing team. */
  @Get('recap')
  getRecap(@Query('year') year?: string, @Query('teamId') teamId?: string) {
    let parsedYear: number | null = null;
    if (year) {
      parsedYear = Number(year);
      if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2200) {
        throw new BadRequestException('year must be a four-digit year');
      }
    }
    let parsedTeam: number | null = null;
    if (teamId) {
      parsedTeam = Number(teamId);
      if (!Number.isInteger(parsedTeam) || parsedTeam === 0) throw new BadRequestException('teamId must be an integer');
    }
    return this.recapService.getRecap({ year: parsedYear, teamId: parsedTeam });
  }

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
