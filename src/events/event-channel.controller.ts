import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { EventChannelService, type EventChannelResult, type EventChannelStatus } from './event-channel.service.js';

/** The Discord channel for a whole event (not a crew). ADMIN only. */
@Controller('events/:eventId/discord-channel')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class EventChannelController {
  constructor(private readonly channels: EventChannelService) {}

  @Get()
  get(@Param('eventId', ParseUUIDPipe) eventId: string): Promise<EventChannelStatus> {
    return this.channels.getStatus(eventId);
  }

  @Post()
  ensure(@Param('eventId', ParseUUIDPipe) eventId: string, @CurrentUser() user: User): Promise<EventChannelResult> {
    return this.channels.ensureChannel(eventId, user.id);
  }
}
