import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { filter, interval, map, merge, Observable, Subject } from 'rxjs';

/** What changed — the plan page maps this to the loaders it re-runs:
 *  - 'stints': the team's stint rows (create/update/delete/reorder/start-now, or stints unassigned).
 *  - 'team': the team's own settings row.
 *  - 'drivers': planning INPUTS (signups/availability, guest drivers, per-driver pace). The stint
 *    rows are untouched; a change that also rewrites stints emits 'stints' as well.
 *  - 'event': event-level data (fuel/tyre limit, status, timeslots). */
export type TeamPlanChangeKind = 'stints' | 'team' | 'drivers' | 'event';

/** Wildcard team id: deliver to every team's subscribers of the event (event-level changes such
 * as the fuel limit, or a signup change where the affected team isn't known). */
export const ALL_TEAMS = '*';

export interface TeamPlanChange {
  eventId: string;
  /** A concrete team id, or ALL_TEAMS. */
  teamId: string;
  kind: TeamPlanChangeKind;
  /** The user whose request caused it, when known. */
  byUserId: string | null;
  /** ISO timestamp. */
  at: string;
}

/** Same shape as @nestjs/common's MessageEvent (declared structurally so it is easy to test). */
export interface TeamPlanMessageEvent {
  data: string | object;
  type?: string;
}

/** Heartbeat so reverse proxies (nginx default read timeout is 60s) don't drop an idle stream. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * In-memory fan-out of "the plan changed" signals to every browser that has a team's stint-plan
 * page open (served over SSE by TeamPlanStreamController). Deliberately carries no plan data —
 * clients refetch through the normal, permission-checked REST endpoints, so the stream can never
 * leak or go stale. Single backend instance only: a second instance would need a shared bus
 * (e.g. Postgres LISTEN/NOTIFY or Redis) behind the same two methods.
 */
@Injectable()
export class TeamPlanEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(TeamPlanEventsService.name);
  private readonly changes = new Subject<TeamPlanChange>();

  /** Fire-and-forget; never throws, so a call site can sit right after a successful DB write
   * without a try/catch of its own. */
  emit(eventId: string, teamId: string, kind: TeamPlanChangeKind, byUserId?: string | null): void {
    try {
      this.changes.next({ eventId, teamId, kind, byUserId: byUserId ?? null, at: new Date().toISOString() });
    } catch (err) {
      this.logger.warn(`Emitting plan change failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Completes the subject on shutdown so every open SSE stream ends (releasing its heartbeat
   * timer) instead of lingering until the process exits. */
  onModuleDestroy(): void {
    this.changes.complete();
  }

  /** Changes relevant to one team's plan page: that team's own, plus any wildcard ones for its event. */
  stream(eventId: string, teamId: string): Observable<TeamPlanChange> {
    return this.changes.pipe(
      filter((c) => c.eventId === eventId && (c.teamId === teamId || c.teamId === ALL_TEAMS)),
    );
  }

  /** The SSE body: each change as an unnamed message (EventSource.onmessage) with a JSON payload,
   * plus a named `heartbeat` event every 25s that onmessage ignores. Unsubscribing (the client
   * disconnecting) tears down both the subject subscription and the interval. */
  sse(eventId: string, teamId: string, heartbeatMs: number = HEARTBEAT_INTERVAL_MS): Observable<TeamPlanMessageEvent> {
    const changes = this.stream(eventId, teamId).pipe(map((change): TeamPlanMessageEvent => ({ data: change })));
    const heartbeat = interval(heartbeatMs).pipe(
      map((): TeamPlanMessageEvent => ({ type: 'heartbeat', data: { at: new Date().toISOString() } })),
    );
    return merge(changes, heartbeat);
  }
}
