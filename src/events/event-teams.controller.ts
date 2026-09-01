import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { CreateEventTeamDto } from './dto/create-event-team.dto.js';
import { UpdateEventTeamDto } from './dto/update-event-team.dto.js';
import { EventTeamsService } from './event-teams.service.js';

@Controller('events/:eventId/teams')
@UseGuards(JwtAuthGuard)
export class EventTeamsController {
  constructor(private readonly eventTeamsService: EventTeamsService) {}

  @Get()
  findAll(@Param('eventId') eventId: string) {
    return this.eventTeamsService.listForEvent(eventId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(@Param('eventId') eventId: string, @Body() dto: CreateEventTeamDto) {
    return this.eventTeamsService.create(eventId, dto);
  }

  @Patch(':teamId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('eventId') eventId: string, @Param('teamId') teamId: string, @Body() dto: UpdateEventTeamDto) {
    return this.eventTeamsService.update(eventId, teamId, dto);
  }

  @Delete(':teamId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('eventId') eventId: string, @Param('teamId') teamId: string) {
    return this.eventTeamsService.remove(eventId, teamId);
  }
}
