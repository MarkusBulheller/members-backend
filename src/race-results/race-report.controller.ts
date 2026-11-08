import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { PostRaceReportDto } from './dto/post-race-report.dto.js';
import type { RaceReport } from './race-report.js';
import { RaceReportService } from './race-report.service.js';

/** The race report of a result: any member can read the draft, only an admin can post it to Discord. */
@Controller('race-results/:id/report')
@UseGuards(JwtAuthGuard)
export class RaceReportController {
  constructor(private readonly reports: RaceReportService) {}

  @Get()
  draft(@Param('id', ParseUUIDPipe) id: string): Promise<RaceReport> {
    return this.reports.getDraft(id);
  }

  @Post('post')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  post(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostRaceReportDto): Promise<{ posted: true }> {
    return this.reports.post(id, dto.text);
  }
}
