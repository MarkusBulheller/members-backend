import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TeamManage } from '../auth/team-manage.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/user.entity.js';
import { CreateEventTeamDummyDriverDto } from './dto/create-event-team-dummy-driver.dto.js';
import { UpdateEventTeamDummyDriverDto } from './dto/update-event-team-dummy-driver.dto.js';
import { EventTeamDummyDriversService } from './event-team-dummy-drivers.service.js';

@Controller('events/:eventId/teams/:teamId/dummy-drivers')
@UseGuards(JwtAuthGuard)
export class EventTeamDummyDriversController {
  constructor(private readonly dummyDriversService: EventTeamDummyDriversService) {}

  @Get()
  findAll(@Param('eventId') eventId: string, @Param('teamId') teamId: string) {
    return this.dummyDriversService.list(eventId, teamId);
  }

  @Post()
  @TeamManage()
  create(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Body() dto: CreateEventTeamDummyDriverDto,
    @CurrentUser() user: User,
  ) {
    return this.dummyDriversService.create(eventId, teamId, dto, user.id);
  }

  @Patch(':dummyId')
  @TeamManage()
  update(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('dummyId') dummyId: string,
    @Body() dto: UpdateEventTeamDummyDriverDto,
    @CurrentUser() user: User,
  ) {
    return this.dummyDriversService.update(eventId, teamId, dummyId, dto, user.id);
  }

  @Delete(':dummyId')
  @TeamManage()
  remove(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('dummyId') dummyId: string,
    @CurrentUser() user: User,
  ) {
    return this.dummyDriversService.remove(eventId, teamId, dummyId, user.id);
  }
}
