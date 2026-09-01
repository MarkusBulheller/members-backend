import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { DriversService } from '../drivers/drivers.service.js';
import { User } from '../users/user.entity.js';
import { OAuthCallbackDto } from './dto/oauth-callback.dto.js';
import { IracingCarUsageService } from './iracing-car-usage.service.js';
import { IracingCarsService } from './iracing-cars.service.js';
import { IracingDriverLookupService } from './iracing-driver-lookup.service.js';
import { IracingSeriesService } from './iracing-series.service.js';
import { IracingTeamsService } from './iracing-teams.service.js';
import { IracingTracksService } from './iracing-tracks.service.js';
import { IracingService } from './iracing.service.js';

@Controller('iracing')
@UseGuards(JwtAuthGuard)
export class IracingController {
  constructor(
    private readonly iracingService: IracingService,
    private readonly driversService: DriversService,
    private readonly iracingCarsService: IracingCarsService,
    private readonly iracingTracksService: IracingTracksService,
    private readonly iracingSeriesService: IracingSeriesService,
    private readonly iracingDriverLookupService: IracingDriverLookupService,
    private readonly iracingTeamsService: IracingTeamsService,
    private readonly iracingCarUsageService: IracingCarUsageService,
  ) {}

  @Post('link')
  async link(@Body() dto: OAuthCallbackDto, @CurrentUser() user: User) {
    const snapshot = await this.iracingService.exchangeCodeForLinkResult(dto.code, dto.codeVerifier);
    return this.driversService.applyIracingLink(user.id, snapshot);
  }

  @Get('cars')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  listCars(@Query('includeRetired') includeRetired?: string) {
    return this.iracingCarsService.list(includeRetired === 'true');
  }

  @Post('cars/sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  syncCars(@Body() dto: OAuthCallbackDto) {
    return this.iracingCarsService.sync(dto.code, dto.codeVerifier);
  }

  @Get('tracks')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  listTracks(@Query('includeRetired') includeRetired?: string) {
    return this.iracingTracksService.list(includeRetired === 'true');
  }

  @Post('tracks/sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  syncTracks(@Body() dto: OAuthCallbackDto) {
    return this.iracingTracksService.sync(dto.code, dto.codeVerifier);
  }

  @Get('series')
  listSeries() {
    return this.iracingSeriesService.list();
  }

  @Post('series/sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  syncSeries(@Body() dto: OAuthCallbackDto) {
    return this.iracingSeriesService.sync(dto.code, dto.codeVerifier);
  }

  @Get('series/:seasonId/weather/:raceWeekNum')
  getSeriesWeather(@Param('seasonId') seasonId: string, @Param('raceWeekNum') raceWeekNum: string) {
    return this.iracingSeriesService.getWeatherForecast(Number(seasonId), Number(raceWeekNum));
  }

  @Patch('series/:seasonId/track-car-usage')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  setTrackCarUsage(@Param('seasonId') seasonId: string, @Body('tracked') tracked: boolean) {
    return this.iracingCarUsageService.setTracked(Number(seasonId), tracked);
  }

  @Get('series/:seasonId/car-usage/:raceWeekNum')
  getCarUsage(@Param('seasonId') seasonId: string, @Param('raceWeekNum') raceWeekNum: string) {
    return this.iracingCarUsageService.getTierlist(Number(seasonId), Number(raceWeekNum));
  }

  @Get('drivers/search')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  searchDrivers(@Query('q') query: string, @CurrentUser() user: User) {
    return this.iracingDriverLookupService.searchAsAdmin(user.id, query ?? '');
  }

  @Get('teams')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  listTeams() {
    return this.iracingTeamsService.list();
  }

  @Post('teams/sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  syncTeams(@Body() dto: OAuthCallbackDto) {
    return this.iracingTeamsService.sync(dto.code, dto.codeVerifier);
  }
}
