import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
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
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  upsert(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() dto: UpsertEventTeamDriverSettingsDto,
  ) {
    return this.settingsService.upsert(eventId, teamId, userId, dto);
  }
}
