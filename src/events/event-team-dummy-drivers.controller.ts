import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
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
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Body() dto: CreateEventTeamDummyDriverDto,
  ) {
    return this.dummyDriversService.create(eventId, teamId, dto);
  }

  @Patch(':dummyId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(
    @Param('eventId') eventId: string,
    @Param('teamId') teamId: string,
    @Param('dummyId') dummyId: string,
    @Body() dto: UpdateEventTeamDummyDriverDto,
  ) {
    return this.dummyDriversService.update(eventId, teamId, dummyId, dto);
  }

  @Delete(':dummyId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('eventId') eventId: string, @Param('teamId') teamId: string, @Param('dummyId') dummyId: string) {
    return this.dummyDriversService.remove(eventId, teamId, dummyId);
  }
}
