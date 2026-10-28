import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { debounceTime, filter, interval, map, merge, Observable, Subject, takeWhile } from 'rxjs';
import { HEARTBEAT_INTERVAL_MS, TeamPlanEventsService, type TeamPlanMessageEvent } from '../team-plan-events.service.js';
import type { FollowTarget } from './follow-state.service.js';

/** Most simultaneous public streams per link; the next one gets a 429. */
export const MAX_FOLLOW_STREAMS_PER_TOKEN = 100;
/** Plan changes arrive in bursts (a reshuffle rewrites many rows); viewers get one nudge. */
export const FOLLOW_CHANGE_DEBOUNCE_MS = 500;
/** A reserved slot whose stream never got subscribed (client vanished mid-handshake) is freed after this. */
const UNCLAIMED_SLOT_TTL_MS = 10_000;

interface FollowSignal {
  teamId: string;
  kind: 'changed' | 'revoked';
}

/** Live feed behind GET /public/follow/:token/stream. Like the planner's stream it carries no plan
 * data: unnamed `{"changed":true}` messages tell the page to refetch GET /public/follow/:token.
 * `{"revoked":true}` is sent once, right before the stream completes, when the admin turns the link
 * off or regenerates it. In-memory, single backend instance (same limitation as TeamPlanEventsService). */
@Injectable()
export class FollowStreamService {
  private readonly connections = new Map<string, number>();
  private readonly signals = new Subject<FollowSignal>();

  constructor(private readonly planEvents: TeamPlanEventsService) {}

  /** The link's display settings changed (names mode): connected pages should refetch. */
  notifyChanged(teamId: string): void {
    this.signals.next({ teamId, kind: 'changed' });
  }

  /** The link was turned off or regenerated: every stream open on the team ends with `revoked`. */
  notifyRevoked(teamId: string): void {
    this.signals.next({ teamId, kind: 'revoked' });
  }

  openCount(token: string): number {
    return this.connections.get(token) ?? 0;
  }

  /** Reserves a connection slot for `token` (429 when the link already has the maximum) and returns
   * the SSE body. The slot is released when the client disconnects or the stream completes. */
  open(
    token: string,
    target: FollowTarget,
    options: { heartbeatMs?: number; debounceMs?: number } = {},
  ): Observable<TeamPlanMessageEvent> {
    if (this.openCount(token) >= MAX_FOLLOW_STREAMS_PER_TOKEN) {
      throw new HttpException('Too many open connections', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.connections.set(token, this.openCount(token) + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = this.openCount(token) - 1;
      if (left > 0) this.connections.set(token, left);
      else this.connections.delete(token);
    };
    const unclaimedTimer = setTimeout(release, UNCLAIMED_SLOT_TTL_MS);
    unclaimedTimer.unref?.();

    const { teamId, eventId } = target;
    return new Observable<TeamPlanMessageEvent>((subscriber) => {
      clearTimeout(unclaimedTimer);
      const mine = this.signals.pipe(filter((s) => s.teamId === teamId));
      // Plan changes (stints / team / drivers for this team, plus event-wide 'event' ones) and
      // display-setting changes, collapsed into one nudge per burst.
      const changes$ = merge(
        this.planEvents.stream(eventId, teamId),
        mine.pipe(filter((s) => s.kind === 'changed')),
      ).pipe(
        debounceTime(options.debounceMs ?? FOLLOW_CHANGE_DEBOUNCE_MS),
        map((): TeamPlanMessageEvent => ({ data: { changed: true } })),
      );
      const heartbeat$ = interval(options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS).pipe(
        map((): TeamPlanMessageEvent => ({ type: 'heartbeat', data: { at: new Date().toISOString() } })),
      );
      const revoked$ = mine.pipe(
        filter((s) => s.kind === 'revoked'),
        map((): TeamPlanMessageEvent => ({ data: { revoked: true } })),
      );
      const subscription = merge(changes$, heartbeat$, revoked$)
        // inclusive: the revoked message itself is delivered, then the stream completes.
        .pipe(takeWhile((m) => !(typeof m.data === 'object' && 'revoked' in m.data), true))
        .subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        release();
      };
    });
  }
}
