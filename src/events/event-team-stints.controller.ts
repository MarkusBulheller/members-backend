import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { CreateEventTeamStintDto } from './dto/create-event-team-stint.dto.js';
import { MoveEventTeamStintDto } from './dto/move-event-team-stint.dto.js';
import { UpdateEventTeamStintDto } from './dto/update-event-team-stint.dto.js';
import { EventTeamStintsService } from './event-team-stints.service.js';

@Controller('events/:eventId/teams/:teamId/stints')
@UseGuards(JwtAuthGuard)
export class EventTeamStintsController {
  constructor(private readonly stintsService: EventTeamStintsService) {}

  @Get()
  findAll(@Param('eventId') eventId: string, @Param('teamId') teamId: string) {
    return this.stintsService.listForTeam(eventId, teamId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(@Param('eventId') eventId: string, @Param('teamId') teamId: string, @Body() dto: CreateEventTeamStintDto) {
    return this.stintsService.create(eventId, teamId, dto);
  }

  @Patch(':stintId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: UpdateEventTeamStintDto,
  ) {
    return this.stintsService.update(eventId, teamId, stintId, dto);
  }

  @Patch(':stintId/move')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  move(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: MoveEventTeamStintDto,
  ) {
    return this.stintsService.move(eventId, teamId, stintId, dto.direction);
  }

  @Patch(':stintId/start-now')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  toggleStartNow(@Param('eventId') eventId: string, @Param('teamId') teamId: string, @Param('stintId') stintId: string) {
    return this.stintsService.toggleStartNow(eventId, teamId, stintId);
  }

  @Delete(':stintId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('eventId') eventId: string, @Param('teamId') teamId: string, @Param('stintId') stintId: string) {
    return this.stintsService.remove(eventId, teamId, stintId);
  }
}
