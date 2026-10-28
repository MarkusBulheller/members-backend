import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { TeamLeadsService, type TeamLeadView } from '../auth/team-leads.service.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { ReplaceEventTeamLeadsDto } from './dto/replace-event-team-leads.dto.js';

/** Admin management of the leads of ONE event crew (see EventTeamLead). ADMIN only. */
@Controller('events/:eventId/teams/:teamId/leads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class EventTeamLeadsController {
  constructor(private readonly teamLeads: TeamLeadsService) {}

  @Get()
  list(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<TeamLeadView[]> {
    return this.teamLeads.listForEventTeam(eventId, teamId);
  }

  /** Replaces the crew's lead set; only approved members placed on this crew are accepted. */
  @Put()
  replace(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: ReplaceEventTeamLeadsDto,
  ): Promise<TeamLeadView[]> {
    return this.teamLeads.replaceForEventTeam(eventId, teamId, dto.userIds);
  }
}
