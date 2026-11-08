import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { TeamManage } from '../../auth/team-manage.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PublishPlanDto } from './dto/publish-plan.dto.js';
import { UpdateFollowLinkDto } from './dto/update-follow-link.dto.js';
import { FollowLinkService, type FollowLink } from './follow-link.service.js';

/** Management of a team's live links (the public "Follow the race" link and the private strategy
 * link): admins and the lead of the team's iRacing team (see TeamManagePolicy) only — the tokens are
 * the credentials for anonymous access, so other members never see them. */
@Controller('events/:eventId/teams/:teamId/follow-link')
@UseGuards(JwtAuthGuard)
export class FollowLinkController {
  constructor(private readonly links: FollowLinkService) {}

  @Get()
  @TeamManage()
  get(@Param('eventId', ParseUUIDPipe) eventId: string, @Param('teamId', ParseUUIDPipe) teamId: string): Promise<FollowLink> {
    return this.links.get(eventId, teamId);
  }

  @Put()
  @TeamManage()
  update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: UpdateFollowLinkDto,
  ): Promise<FollowLink> {
    return this.links.update(eventId, teamId, dto);
  }

  /** The plan page publishes the schedule it computed (times, fuel, tyres) here, so the follow page
   * and overlay match it. */
  @Put('plan')
  @HttpCode(204)
  @TeamManage()
  publishPlan(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: PublishPlanDto,
  ): Promise<void> {
    return this.links.publishPlan(eventId, teamId, dto);
  }
}
