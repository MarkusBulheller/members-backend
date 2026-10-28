import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { TeamManage } from '../../auth/team-manage.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { UpdateFollowLinkDto } from './dto/update-follow-link.dto.js';
import { FollowLinkService, type FollowLink } from './follow-link.service.js';

/** Management of a team's public "Follow the race" link: admins and the lead of the team's iRacing
 * team (see TeamManagePolicy) only — the token is the credential for anonymous access, so other
 * members never see it. */
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
}
