import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { CreateTeamHighlightDto } from './dto/create-team-highlight.dto.js';
import { MoveTeamHighlightDto } from './dto/move-team-highlight.dto.js';
import { UpdateTeamHighlightDto } from './dto/update-team-highlight.dto.js';
import { TeamHighlightsService } from './team-highlights.service.js';

@Controller('team-highlights')
@UseGuards(JwtAuthGuard)
export class TeamHighlightsController {
  constructor(private readonly teamHighlightsService: TeamHighlightsService) {}

  @Get()
  list() {
    return this.teamHighlightsService.list();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateTeamHighlightDto) {
    return this.teamHighlightsService.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateTeamHighlightDto) {
    return this.teamHighlightsService.update(id, dto);
  }

  @Patch(':id/move')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  move(@Param('id') id: string, @Body() dto: MoveTeamHighlightDto) {
    return this.teamHighlightsService.move(id, dto.direction);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.teamHighlightsService.remove(id);
  }
}
