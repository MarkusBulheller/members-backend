import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { LookupRaceResultDto } from './dto/lookup-race-result.dto.js';
import { RaceResultsService } from './race-results.service.js';

@Controller('race-results')
@UseGuards(JwtAuthGuard)
export class RaceResultsController {
  constructor(private readonly raceResultsService: RaceResultsService) {}

  @Get()
  findAll() {
    return this.raceResultsService.list();
  }

  @Get('by-driver/:driverProfileId')
  findByDriver(@Param('driverProfileId') driverProfileId: string) {
    return this.raceResultsService.findByDriverProfileId(driverProfileId);
  }

  @Get('by-car/:carId')
  findByCar(@Param('carId') carId: string) {
    return this.raceResultsService.findByCarId(carId);
  }

  @Get('by-track/:trackId')
  findByTrack(@Param('trackId') trackId: string) {
    return this.raceResultsService.findByTrackId(trackId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.raceResultsService.findByIdOrThrow(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: LookupRaceResultDto, @CurrentUser() user: User) {
    return this.raceResultsService.importFromIracing(user.id, dto.subsessionId, dto.teamId);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.raceResultsService.remove(id);
  }

  @Post(':id/share')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  share(@Param('id') id: string) {
    return this.raceResultsService.generateShareLink(id);
  }

  @Delete(':id/share')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  unshare(@Param('id') id: string) {
    return this.raceResultsService.revokeShareLink(id);
  }
}
