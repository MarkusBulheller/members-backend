import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { EventsService } from './events.service.js';

/** Deliberately unguarded — same rationale as PublicStatsController/PublicTeamHighlightsController:
 * the separate, anonymous public marketing site reads this to show real upcoming events instead
 * of hardcoding a schedule in that project's own source. Only PUBLISHED, still-upcoming events,
 * and only the fields safe to show anonymously — no signups, no roster.
 *
 * Route is nested two segments deep (public/upcoming, not a sibling like public-upcoming)
 * specifically so it can never collide with EventsController's GET /events/:id regardless of
 * which controller Nest happens to register routes from first — a single path segment would
 * risk exactly that, the same trap EventsController's own 'mine/upcoming-stints' route avoids by
 * being declared ahead of ':id' in that controller. Two segments never match a one-segment
 * :id route in Express, so there's nothing to get the ordering right for. */
@Controller('events')
export class PublicEventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get('public/upcoming')
  findPublicUpcoming(@Query('limit', new DefaultValuePipe(4), ParseIntPipe) limit: number) {
    return this.eventsService.findPublicUpcoming(Math.min(limit, 20));
  }
}
