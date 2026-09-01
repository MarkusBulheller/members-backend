import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { CarTrackSetupsService } from './car-track-setups.service.js';
import { CreateCarTrackSetupDto } from './dto/create-car-track-setup.dto.js';
import { UpdateCarTrackSetupDto } from './dto/update-car-track-setup.dto.js';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CarTrackSetupsController {
  constructor(private readonly setupsService: CarTrackSetupsService) {}

  @Post('cars/:carId/track-setups')
  create(@Param('carId') carId: string, @Body() dto: CreateCarTrackSetupDto) {
    return this.setupsService.create(carId, dto);
  }

  @Patch('track-setups/:id')
  update(@Param('id') id: string, @Body() dto: UpdateCarTrackSetupDto) {
    return this.setupsService.update(id, dto);
  }

  @Delete('track-setups/:id')
  remove(@Param('id') id: string) {
    return this.setupsService.remove(id);
  }
}
