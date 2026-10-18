import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
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
  create(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Body() dto: CreateEventTeamStintDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.create(eventId, teamId, dto, user.id);
  }

  @Patch(':stintId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: UpdateEventTeamStintDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.update(eventId, teamId, stintId, dto, user.id);
  }

  @Patch(':stintId/move')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  move(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: MoveEventTeamStintDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.move(eventId, teamId, stintId, dto.direction, user.id);
  }

  @Patch(':stintId/start-now')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  toggleStartNow(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.toggleStartNow(eventId, teamId, stintId, user.id);
  }

  @Delete(':stintId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.remove(eventId, teamId, stintId, user.id);
  }
}
