import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { AdminAddSignupDto } from './dto/admin-add-signup.dto.js';
import { AssignSignupTeamDto } from './dto/assign-signup-team.dto.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { OverrideSignupDto } from './dto/override-signup.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { EventTeamUpcomingStintsService } from './event-team-upcoming-stints.service.js';
import { EventsService } from './events.service.js';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly upcomingStintsService: EventTeamUpcomingStintsService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: User) {
    return this.eventsService.findAllForViewer(user.role === Role.ADMIN, user.id);
  }

  // Must come before ':id' — otherwise "mine" would be swallowed as an event id.
  @Get('mine/upcoming-stints')
  findMyUpcomingStints(@CurrentUser() user: User) {
    return this.upcomingStintsService.findForUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.eventsService.findByIdForViewer(id, user.role === Role.ADMIN, user.id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateEventDto, @CurrentUser() user: User) {
    return this.eventsService.create(dto, user.id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() user: User) {
    return this.eventsService.update(id, dto, user.id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.eventsService.remove(id);
  }

  @Post(':id/signup')
  signup(@Param('id') id: string, @Body() dto: SignupDto, @CurrentUser() user: User) {
    return this.eventsService.signup(id, user.id, dto);
  }

  @Delete(':id/signup')
  cancelSignup(@Param('id') id: string, @CurrentUser() user: User) {
    return this.eventsService.cancelSignup(id, user.id);
  }

  @Post(':id/signups')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  addSignup(@Param('id') id: string, @Body() dto: AdminAddSignupDto, @CurrentUser() user: User) {
    return this.eventsService.adminAddSignup(id, dto, user.id);
  }

  @Patch(':id/signups/:signupId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  overrideSignup(@Param('signupId') signupId: string, @Body() dto: OverrideSignupDto, @CurrentUser() user: User) {
    return this.eventsService.adminOverrideSignup(signupId, dto.status, user.id);
  }

  @Patch(':id/signups/:signupId/details')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateSignupDetails(
    @Param('id') id: string,
    @Param('signupId') signupId: string,
    @Body() dto: SignupDto,
    @CurrentUser() user: User,
  ) {
    return this.eventsService.adminUpdateSignup(id, signupId, dto, user.id);
  }

  @Patch(':id/signups/:signupId/team')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  assignSignupTeam(
    @Param('id') id: string,
    @Param('signupId') signupId: string,
    @Body() dto: AssignSignupTeamDto,
    @CurrentUser() user: User,
  ) {
    return this.eventsService.assignSignupTeam(id, signupId, dto.eventTeamId, user.id);
  }

  @Delete(':id/signups/:signupId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  deleteSignup(@Param('id') id: string, @Param('signupId') signupId: string, @CurrentUser() user: User) {
    return this.eventsService.deleteSignup(id, signupId, user.id);
  }
}
