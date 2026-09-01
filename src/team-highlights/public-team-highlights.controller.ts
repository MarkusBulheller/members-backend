import { Controller, Get } from '@nestjs/common';
import { TeamHighlightsService } from './team-highlights.service.js';

/** Deliberately unguarded — same rationale as PublicStatsController: the separate, anonymous
 * public marketing site reads this to render its "Team Highlights" timeline with real,
 * admin-managed history instead of hardcoding it in that project's own source. */
@Controller('team-highlights')
export class PublicTeamHighlightsController {
  constructor(private readonly teamHighlightsService: TeamHighlightsService) {}

  @Get('public')
  list() {
    return this.teamHighlightsService.list();
  }
}
