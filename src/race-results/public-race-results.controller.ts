import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { RaceResultsService } from './race-results.service.js';

/** Deliberately unguarded. /shared/:token: a race result only becomes reachable there once an
 * admin explicitly generates a share link for it (RaceResultsController.share()); every other
 * result stays behind the normal login-gated /race-results/:id route on RaceResultsController.
 * /public/recent: the separate, anonymous public marketing site's "Recent Results" table — real
 * finishes, no driver names, no per-lap detail. Both routes are two segments deep specifically so
 * neither can ever collide with RaceResultsController's GET /race-results/:id regardless of
 * controller registration order (a one-segment route would risk exactly that). Kept as a
 * separate controller class (rather than public routes on the guarded one) so there's no chance
 * of an unguarded method accidentally sharing a class-level @UseGuards with the rest of the CRUD
 * surface. */
@Controller('race-results')
export class PublicRaceResultsController {
  constructor(private readonly raceResultsService: RaceResultsService) {}

  @Get('shared/:token')
  findByShareToken(@Param('token') token: string) {
    return this.raceResultsService.findByShareTokenOrThrow(token);
  }

  @Get('public/recent')
  findPublicRecent(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.raceResultsService.findPublicRecent(Math.min(limit, 20));
  }
}
