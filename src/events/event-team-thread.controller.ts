import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import {
  EventTeamThreadService,
  type TeamThreadResult,
  type TeamThreadStatus,
} from './event-team-thread.service.js';

/** The Discord thread for one event team. ADMIN only for now. */
@Controller('events/:eventId/teams/:teamId/discord-thread')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class EventTeamThreadController {
  constructor(private readonly threads: EventTeamThreadService) {}

  @Get()
  get(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<TeamThreadStatus> {
    return this.threads.getStatus(eventId, teamId);
  }

  @Post()
  ensure(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: User,
  ): Promise<TeamThreadResult> {
    return this.threads.ensureThread(eventId, teamId, user.id);
  }

  @Post('plan-summary')
  postPlanSummary(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<{ posted: number }> {
    return this.threads.postPlanSummary(eventId, teamId);
  }
}
