import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { AchievementsService } from './achievements.service.js';
import { CreateAchievementAwardDto } from './dto/create-achievement-award.dto.js';
import { CreateAchievementDefinitionDto } from './dto/create-achievement-definition.dto.js';
import { UpdateAchievementDefinitionDto } from './dto/update-achievement-definition.dto.js';

@Controller('achievements')
@UseGuards(JwtAuthGuard)
export class AchievementsController {
  constructor(private readonly achievementsService: AchievementsService) {}

  @Get('definitions')
  listDefinitions() {
    return this.achievementsService.listDefinitions();
  }

  @Post('definitions')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  createDefinition(@Body() dto: CreateAchievementDefinitionDto) {
    return this.achievementsService.createDefinition(dto);
  }

  @Patch('definitions/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  updateDefinition(@Param('id') id: string, @Body() dto: UpdateAchievementDefinitionDto) {
    return this.achievementsService.updateDefinition(id, dto);
  }

  @Delete('definitions/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  removeDefinition(@Param('id') id: string) {
    return this.achievementsService.removeDefinition(id);
  }

  @Post('definitions/:id/recalculate')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  recalculate(@Param('id') id: string) {
    return this.achievementsService.recalculate(id);
  }

  @Post('awards')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  award(@Body() dto: CreateAchievementAwardDto) {
    return this.achievementsService.award(dto);
  }

  @Delete('awards/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  revokeAward(@Param('id') id: string) {
    return this.achievementsService.revokeAward(id);
  }
}
