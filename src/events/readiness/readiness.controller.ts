import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Role } from '../../common/enums/role.enum.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { User } from '../../users/user.entity.js';
import { ReadinessService } from './readiness.service.js';
import type { ReadinessResult } from './readiness.types.js';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class ReadinessController {
  constructor(private readonly readinessService: ReadinessService) {}

  /** Informational race-readiness report. Admins see every team and the event-level checks; a
   * member sees only the teams they are placed on. */
  @Get(':id/readiness')
  getReadiness(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User): Promise<ReadinessResult> {
    return this.readinessService.getReadiness(id, user.role === Role.ADMIN, user.id);
  }
}
