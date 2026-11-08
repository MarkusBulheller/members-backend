import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { TeamManage } from '../auth/team-manage.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { SetPlanBaselineDto } from './dto/set-plan-baseline.dto.js';
import type { PlanBaseline } from './plan-baseline.js';
import { PlanBaselineService } from './plan-baseline.service.js';

/** The original plan of a crew (what "vs plan" is measured against). Every member who can see the
 * plan can read it; saving and clearing it is for admins and the team's lead. */
@Controller('events/:eventId/teams/:teamId/plan-baseline')
@UseGuards(JwtAuthGuard)
export class PlanBaselineController {
  constructor(private readonly baselines: PlanBaselineService) {}

  @Get()
  get(@Param('eventId', ParseUUIDPipe) eventId: string, @Param('teamId', ParseUUIDPipe) teamId: string): Promise<PlanBaseline | null> {
    return this.baselines.get(eventId, teamId);
  }

  @Put()
  @TeamManage()
  set(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: SetPlanBaselineDto,
    @CurrentUser() user: { id: string },
  ): Promise<PlanBaseline> {
    return this.baselines.set(eventId, teamId, dto, user.id);
  }

  @Delete()
  @HttpCode(204)
  @TeamManage()
  clear(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: { id: string },
  ): Promise<void> {
    return this.baselines.clear(eventId, teamId, user.id);
  }
}
