import { Controller, Get, HttpException, HttpStatus, Param, Req, Res, Sse } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import type { TeamPlanMessageEvent } from '../team-plan-events.service.js';
import { clientIp, FixedWindowRateLimiter } from './follow-rate-limiter.js';
import { FollowStateService, type FollowState } from './follow-state.service.js';
import { FollowStreamService } from './follow-stream.service.js';

export const FOLLOW_STATE_LIMIT_PER_MINUTE = 120;
export const FOLLOW_STREAM_CONNECT_LIMIT_PER_MINUTE = 60;

/** Deliberately unguarded (no JwtAuthGuard — like PublicRaceResultsController / PublicStatsController):
 * the "Follow the race" page and OBS overlay are anonymous and read-only. A team only becomes
 * reachable here once an admin enables its private link (FollowLinkController); the payload is the
 * FollowState contract and nothing else. Unknown, revoked and hidden-event tokens all give the same
 * 404. Kept as its own controller class so no unguarded method can share a guarded class's
 * @UseGuards. */
@Controller('public/follow')
export class PublicFollowController {
  private readonly stateLimiter = new FixedWindowRateLimiter(FOLLOW_STATE_LIMIT_PER_MINUTE, 60_000);
  private readonly streamLimiter = new FixedWindowRateLimiter(FOLLOW_STREAM_CONNECT_LIMIT_PER_MINUTE, 60_000);

  constructor(
    private readonly state: FollowStateService,
    private readonly streams: FollowStreamService,
  ) {}

  @Get(':token')
  async getState(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FollowState> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    const verdict = this.stateLimiter.hit(clientIp(req, trustProxy()));
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.state.getState(token);
  }

  /** Unnamed `{"changed":true}` messages (refetch GET /public/follow/:token), a `heartbeat` event
   * every 25s, and one `{"revoked":true}` before the stream ends if the link is switched off. The
   * token is checked once at connect time, so a bad link is an ordinary 404 before any SSE headers. */
  @Sse(':token/stream')
  async stream(@Param('token') token: string, @Req() req: Request): Promise<Observable<TeamPlanMessageEvent>> {
    if (!this.streamLimiter.hit(clientIp(req, trustProxy())).allowed) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const target = await this.state.resolveTarget(token);
    return this.streams.open(token, target);
  }
}

function trustProxy(): boolean {
  return process.env.FOLLOW_TRUST_PROXY === 'true';
}
