import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service.js';

/** Deliberately unguarded — the public marketing site (a separate, anonymous project with no
 * login of its own) shows these as real headline numbers instead of hardcoded ones. Kept as a
 * separate controller class (rather than a public route on the guarded StatsController) so
 * there's no chance of an unguarded method accidentally sharing a class-level @UseGuards with
 * the per-driver dashboard, same rationale as PublicRaceResultsController. */
@Controller('stats')
export class PublicStatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('public-summary')
  getPublicSummary() {
    return this.statsService.getPublicSummary();
  }
}
