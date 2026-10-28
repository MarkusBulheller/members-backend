import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { User } from '../users/user.entity.js';
import { ListResultAttemptsQueryDto } from './dto/list-result-attempts-query.dto.js';
import { UpdateAutoImportSettingsDto } from './dto/update-auto-import-settings.dto.js';
import { IracingAutoImportSettingsService } from './iracing-auto-import-settings.service.js';
import { IracingResultAutoImportService } from './iracing-result-auto-import.service.js';

/** Admin-only controls of the automatic race-result import. */
@Controller('iracing/auto-import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class IracingAutoImportController {
  constructor(
    private readonly settingsService: IracingAutoImportSettingsService,
    private readonly autoImportService: IracingResultAutoImportService,
  ) {}

  @Get()
  getSettings() {
    return this.settingsService.getView();
  }

  @Patch()
  updateSettings(@Body() dto: UpdateAutoImportSettingsDto) {
    return this.settingsService.update(dto);
  }

  @Get('attempts')
  listAttempts(@Query() query: ListResultAttemptsQueryDto) {
    return this.autoImportService.listAttempts(query.status, query.limit);
  }

  @Post('attempts/:id/import')
  @HttpCode(200)
  importAttempt(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.autoImportService.importNow(id, user.id);
  }

  @Post('attempts/:id/ignore')
  @HttpCode(200)
  ignoreAttempt(@Param('id', ParseUUIDPipe) id: string) {
    return this.autoImportService.ignore(id);
  }

  /** Runs the check right now instead of waiting for the next :00/:30 tick. */
  @Post('run')
  @HttpCode(200)
  run() {
    return this.autoImportService.run();
  }
}
