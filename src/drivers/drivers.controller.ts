import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { ApplyIracingSnapshotDto } from './dto/apply-iracing-snapshot.dto.js';
import { CreateManualDriverDto } from './dto/create-manual-driver.dto.js';
import { UpdateDriverProfileDto } from './dto/update-driver-profile.dto.js';
import { UpdateManualDriverDto } from './dto/update-manual-driver.dto.js';
import { DriversService } from './drivers.service.js';

@Controller('drivers')
@UseGuards(JwtAuthGuard)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  findAll() {
    return this.driversService.findAll();
  }

  @Get('me')
  findOwnProfile(@CurrentUser() user: User) {
    return this.driversService.findByUserIdOrThrow(user.id);
  }

  @Patch('me')
  updateOwnProfile(@CurrentUser() user: User, @Body() dto: UpdateDriverProfileDto) {
    return this.driversService.updateOwnProfile(user.id, dto);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  createManualDriver(@Body() dto: CreateManualDriverDto) {
    return this.driversService.createManualDriver(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.driversService.findByIdOrThrow(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateManualDriver(@Param('id') id: string, @Body() dto: UpdateManualDriverDto) {
    return this.driversService.updateManualDriver(id, dto);
  }

  @Patch(':id/settings')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateProfileAsAdmin(@Param('id') id: string, @Body() dto: UpdateDriverProfileDto) {
    return this.driversService.updateProfileAsAdmin(id, dto);
  }

  @Post(':id/iracing-link')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  applyIracingSnapshot(@Param('id') id: string, @Body() dto: ApplyIracingSnapshotDto) {
    return this.driversService.applyIracingSnapshotToManualDriver(id, {
      custId: dto.custId,
      name: dto.name,
      location: dto.location ?? null,
      countryCode: dto.countryCode ?? null,
      sportsCarIrating: dto.sportsCarIrating ?? null,
      sportsCarSafetyRating: dto.sportsCarSafetyRating ?? null,
      refreshToken: null,
    });
  }
}
