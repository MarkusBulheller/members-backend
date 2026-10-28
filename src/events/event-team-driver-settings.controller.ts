import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { TeamManage } from '../auth/team-manage.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/user.entity.js';
import { UpsertEventTeamDriverSettingsDto } from './dto/upsert-event-team-driver-settings.dto.js';
import { EventTeamDriverSettingsService } from './event-team-driver-settings.service.js';

@Controller('events/:eventId/teams/:teamId/driver-settings')
@UseGuards(JwtAuthGuard)
export class EventTeamDriverSettingsController {
  constructor(private readonly settingsService: EventTeamDriverSettingsService) {}

  @Get()
  findAll(@Param('eventId') eventId: string, @Param('teamId') teamId: string) {
    return this.settingsService.listForTeam(eventId, teamId);
  }

  @Patch(':userId')
  @TeamManage()
  upsert(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() dto: UpsertEventTeamDriverSettingsDto,
    @CurrentUser() user: User,
  ) {
    return this.settingsService.upsert(eventId, teamId, userId, dto, user.id);
  }
}
