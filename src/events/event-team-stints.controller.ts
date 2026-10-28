import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TeamManage } from '../auth/team-manage.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/user.entity.js';
import { CreateEventTeamStintDto } from './dto/create-event-team-stint.dto.js';
import { MoveEventTeamStintDto } from './dto/move-event-team-stint.dto.js';
import { StartStintNowDto } from './dto/start-stint-now.dto.js';
import { MoveEventTeamStintToDto } from './dto/stint-position.dto.js';
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
  @TeamManage()
  create(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Body() dto: CreateEventTeamStintDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.create(eventId, teamId, dto, user.id);
  }

  @Patch(':stintId')
  @TeamManage()
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
  @TeamManage()
  move(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: MoveEventTeamStintDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.move(eventId, teamId, stintId, dto.direction, user.id);
  }

  /** Drag and drop: move the stint to a position in the list. */
  @Patch(':stintId/position')
  @TeamManage()
  moveTo(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: MoveEventTeamStintToDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.moveTo(eventId, teamId, stintId, dto.index, user.id);
  }

  @Patch(':stintId/start-now')
  @TeamManage()
  toggleStartNow(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @Body() dto: StartStintNowDto,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.toggleStartNow(eventId, teamId, stintId, user.id, dto?.restart === true);
  }

  @Delete(':stintId')
  @TeamManage()
  remove(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('stintId') stintId: string,
    @CurrentUser() user: User,
  ) {
    return this.stintsService.remove(eventId, teamId, stintId, user.id);
  }
}
