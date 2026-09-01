import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { CreateLiveryDto } from './dto/create-livery.dto.js';
import { LiveriesService } from './liveries.service.js';
import { liveryMulterOptions } from './multer.config.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class LiveriesController {
  constructor(private readonly liveriesService: LiveriesService) {}

  // Any signed-in member can contribute a livery — same spirit as uploadedByUserId already
  // tracking who added it, rather than assuming it's always an admin. Deleting stays admin-only
  // below, so a member can't remove someone else's upload.
  @Post('cars/:carId/liveries')
  @UseInterceptors(FileInterceptor('file', liveryMulterOptions))
  upload(
    @Param('carId') carId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateLiveryDto,
    @CurrentUser() user: User,
  ) {
    if (!file) {
      throw new BadRequestException('A livery image file is required');
    }
    return this.liveriesService.create(carId, file, dto.name, user.id);
  }

  @Delete('liveries/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.liveriesService.remove(id);
  }
}
