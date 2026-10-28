import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { DriversService } from '../drivers/drivers.service.js';
import { User } from '../users/user.entity.js';
import { CreateIracingTeamDto, UpdateIracingTeamDto } from './dto/update-iracing-team.dto.js';
import { OAuthCallbackDto } from './dto/oauth-callback.dto.js';
import { IracingCarUsageService } from './iracing-car-usage.service.js';
import { IracingCarsService } from './iracing-cars.service.js';
import { IracingDriverLookupService } from './iracing-driver-lookup.service.js';
import { IracingSeriesService } from './iracing-series.service.js';
import { IracingTeamsService } from './iracing-teams.service.js';
import { IracingTracksService } from './iracing-tracks.service.js';
import { IracingStatsSyncService } from './iracing-stats-sync.service.js';
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
    private readonly iracingStatsSyncService: IracingStatsSyncService,
  ) {}

  @Post('link')
  async link(@Body() dto: OAuthCallbackDto, @CurrentUser() user: User) {
    const snapshot = await this.iracingService.exchangeCodeForLinkResult(dto.code, dto.codeVerifier);
    return this.driversService.applyIracingLink(user.id, snapshot);
  }

  /** "Re-sync now" on a driver profile — the driver themselves or an admin. */
  @Post('drivers/:id/resync')
  resyncDriver(@Param('id') id: string, @CurrentUser() user: User) {
    return this.iracingStatsSyncService.resyncDriver(id, user);
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

  /** One season with its full schedule (the list omits it). `sync` is POST-only, so no route clash. */
  @Get('series/:seasonId')
  getSeries(@Param('seasonId', ParseIntPipe) seasonId: number) {
    return this.iracingSeriesService.getById(seasonId);
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

  @Get('series/:seasonId/car-usage/:raceWeekNum/summary')
  getCarUsageSummary(@Param('seasonId') seasonId: string, @Param('raceWeekNum') raceWeekNum: string) {
    return this.iracingCarUsageService.getEntriesScanned(Number(seasonId), Number(raceWeekNum));
  }

  @Post('series/:seasonId/car-usage/sync-since')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  async syncCarUsageSince(
    @Param('seasonId') seasonId: string,
    @Body('since') since: string,
    @CurrentUser() user: User,
  ) {
    await this.iracingCarUsageService.scanSince(Number(seasonId), new Date(since), user.id);
    return { ok: true };
  }

  @Get('drivers/search')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  searchDrivers(@Query('q') query: string, @CurrentUser() user: User) {
    return this.iracingDriverLookupService.searchAsAdmin(user.id, query ?? '');
  }

  /** Active teams only; `?includeInactive=true` also returns deactivated ones (admins only —
   * ignored for anyone else, though this route is admin-only today). */
  @Get('teams')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  listTeams(@Query('includeInactive') includeInactive: string | undefined, @CurrentUser() user: User) {
    return this.iracingTeamsService.list(includeInactive === 'true' && user.role === Role.ADMIN);
  }

  /** Adds a team by hand (one we are not in, or that no longer exists). */
  @Post('teams')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  createTeam(@Body() dto: CreateIracingTeamDto) {
    return this.iracingTeamsService.createManual(dto);
  }

  @Delete('teams/:teamId')
  @HttpCode(204)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  async removeTeam(@Param('teamId', ParseIntPipe) teamId: number): Promise<void> {
    await this.iracingTeamsService.removeManual(teamId);
  }

  @Patch('teams/:teamId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateTeam(@Param('teamId', ParseIntPipe) teamId: number, @Body() dto: UpdateIracingTeamDto) {
    return this.iracingTeamsService.update(teamId, dto);
  }

  @Post('teams/sync')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  syncTeams(@Body() dto: OAuthCallbackDto) {
    return this.iracingTeamsService.sync(dto.code, dto.codeVerifier);
  }
}
