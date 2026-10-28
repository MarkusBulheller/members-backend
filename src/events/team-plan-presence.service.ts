import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity.js';
import type { TeamPlanMessageEvent } from './team-plan-events.service.js';

/** One person looking at a team's plan page. */
export interface PresenceUser {
  userId: string;
  /** Driver profile iracingName ?? displayName, else the Discord global name / username. */
  name: string;
  /** The driver profile's avatar path exactly as stored (e.g. "/uploads/avatars/<uuid>.png"), or null. */
  avatarUrl: string | null;
  /** Lets the portal warn when 2+ admins are editing the same plan. */
  isAdmin: boolean;
}

export interface PresenceViewer {
  userId: string;
  isAdmin: boolean;
}

/** Name of the SSE event carrying the presence list (a NAMED event, so EventSource.onmessage ignores it). */
export const PRESENCE_EVENT = 'presence';
/** The list is capped so a crowded plan can't produce an unbounded payload. */
export const PRESENCE_MAX_USERS = 25;
/** Joins/leaves within this window collapse into one broadcast (reconnect flaps don't spam). */
export const PRESENCE_DEBOUNCE_MS = 300;
/** How long a resolved name/avatar is reused before it is looked up again. */
export const PRESENCE_NAME_CACHE_MS = 60_000;
/** Shown when a user can't be resolved (deleted account, or the lookup failed). */
export const PRESENCE_FALLBACK_NAME = 'Member';

interface ResolvedIdentity {
  name: string;
  avatarUrl: string | null;
}

interface IdentityRow {
  id: string;
  globalName: string | null;
  username: string | null;
  iracingName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface PresenceConnection {
  id: string;
  userId: string;
  send: (event: TeamPlanMessageEvent) => void;
  closed: boolean;
  /** The last payload this connection was sent (suppresses identical re-sends). */
  lastJson: string | null;
  /** Room version of the last payload sent (drops results of slower, older resolutions). */
  lastVersion: number;
}

interface PresenceRoom {
  key: string;
  /** Distinct users, in join order, with how many connections (tabs) each has open. */
  users: Map<string, { connections: number; isAdmin: boolean }>;
  connections: Map<string, PresenceConnection>;
  /** Bumped whenever the set of users changes. */
  version: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * In-memory "who has this team's plan open" tracker, served on the plan's SSE stream as a named
 * `presence` event. One user with several tabs counts once. A room (one per event+team) exists
 * only while at least one connection is open, so memory is bounded by the live connections.
 * Single backend instance only, like TeamPlanEventsService.
 */
@Injectable()
export class TeamPlanPresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(TeamPlanPresenceService.name);
  private readonly rooms = new Map<string, PresenceRoom>();
  private readonly identityCache = new Map<string, { value: ResolvedIdentity; expiresAt: number }>();
  /** Lookups currently in flight, so concurrent snapshots don't query the same user twice. */
  private readonly inflight = new Map<string, Promise<ResolvedIdentity | undefined>>();

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * The presence part of one client's SSE body. Subscribing registers the viewer and immediately
   * emits the current list; the list is re-sent (debounced) whenever the set of people changes.
   * Unsubscribing — Nest tears the stream down when the client disconnects — unregisters them.
   * Each message is `{ type: 'presence', data: '<JSON array of PresenceUser>' }`.
   */
  connect(eventId: string, teamId: string, viewer: PresenceViewer): Observable<TeamPlanMessageEvent> {
    return new Observable<TeamPlanMessageEvent>((subscriber) => {
      const room = this.roomFor(eventId, teamId);
      const connection: PresenceConnection = {
        id: randomUUID(),
        userId: viewer.userId,
        send: (event) => subscriber.next(event),
        closed: false,
        lastJson: null,
        lastVersion: -1,
      };
      room.connections.set(connection.id, connection);

      const existing = room.users.get(viewer.userId);
      if (existing) {
        existing.connections += 1;
        existing.isAdmin = viewer.isAdmin;
      } else {
        room.users.set(viewer.userId, { connections: 1, isAdmin: viewer.isAdmin });
        room.version += 1;
        this.scheduleBroadcast(room); // tell everyone else; this connection gets its snapshot below
      }

      void this.sendSnapshot(room, connection);

      return () => this.disconnect(room, connection);
    });
  }

  /** The current list for a team (resolved names). Mainly for tests and diagnostics. */
  async current(eventId: string, teamId: string): Promise<PresenceUser[]> {
    const room = this.rooms.get(this.keyOf(eventId, teamId));
    return room ? (await this.resolve(room)).list : [];
  }

  /** Number of teams with at least one open connection (leak check for tests). */
  get roomCount(): number {
    return this.rooms.size;
  }

  onModuleDestroy(): void {
    for (const room of this.rooms.values()) {
      if (room.timer !== undefined) clearTimeout(room.timer);
    }
    this.rooms.clear();
  }

  private keyOf(eventId: string, teamId: string): string {
    return `${eventId}|${teamId}`;
  }

  private roomFor(eventId: string, teamId: string): PresenceRoom {
    const key = this.keyOf(eventId, teamId);
    let room = this.rooms.get(key);
    if (!room) {
      room = { key, users: new Map(), connections: new Map(), version: 0, timer: undefined };
      this.rooms.set(key, room);
    }
    return room;
  }

  private disconnect(room: PresenceRoom, connection: PresenceConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    room.connections.delete(connection.id);

    const user = room.users.get(connection.userId);
    if (user) {
      user.connections -= 1;
      if (user.connections <= 0) {
        room.users.delete(connection.userId);
        room.version += 1;
        if (room.connections.size > 0) this.scheduleBroadcast(room);
      }
    }

    if (room.connections.size === 0) {
      if (room.timer !== undefined) clearTimeout(room.timer);
      room.timer = undefined;
      // Only drop the map entry if it is still this room (a newer one may have been created).
      if (this.rooms.get(room.key) === room) this.rooms.delete(room.key);
    }
  }

  /** At most one pending broadcast per room: changes within the window share it. */
  private scheduleBroadcast(room: PresenceRoom): void {
    if (room.timer !== undefined) return;
    room.timer = setTimeout(() => {
      room.timer = undefined;
      if (room.connections.size === 0) return;
      void this.broadcast(room);
    }, PRESENCE_DEBOUNCE_MS);
  }

  private async broadcast(room: PresenceRoom): Promise<void> {
    const result = await this.resolve(room);
    for (const connection of [...room.connections.values()]) this.deliver(connection, result);
  }

  private async sendSnapshot(room: PresenceRoom, connection: PresenceConnection): Promise<void> {
    this.deliver(connection, await this.resolve(room));
  }

  private deliver(connection: PresenceConnection, result: { version: number; list: PresenceUser[] }): void {
    if (connection.closed || result.version < connection.lastVersion) return;
    connection.lastVersion = result.version;
    const json = JSON.stringify(result.list);
    if (json === connection.lastJson) return;
    connection.lastJson = json;
    try {
      connection.send({ type: PRESENCE_EVENT, data: json });
    } catch (err) {
      this.logger.warn(`Sending presence failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The room's users in join order (capped), with names looked up. Never rejects. */
  private async resolve(room: PresenceRoom): Promise<{ version: number; list: PresenceUser[] }> {
    const version = room.version;
    const entries = [...room.users.entries()].slice(0, PRESENCE_MAX_USERS);
    const identities = await this.identities(entries.map(([userId]) => userId));
    const list = entries.map(([userId, { isAdmin }]): PresenceUser => {
      const identity = identities.get(userId);
      return {
        userId,
        name: identity?.name ?? PRESENCE_FALLBACK_NAME,
        avatarUrl: identity?.avatarUrl ?? null,
        isAdmin,
      };
    });
    return { version, list };
  }

  /** Cached (60s) name/avatar lookups; every cache miss goes out in ONE batched query. */
  private async identities(userIds: string[]): Promise<Map<string, ResolvedIdentity>> {
    const now = Date.now();
    const result = new Map<string, ResolvedIdentity>();
    const missing: string[] = [];
    for (const id of userIds) {
      const hit = this.identityCache.get(id);
      if (hit && hit.expiresAt > now) result.set(id, hit.value);
      else missing.push(id);
    }
    if (missing.length === 0) return result;

    // Ids another resolution is already fetching are awaited instead of queried a second time.
    const waiting: Promise<void>[] = [];
    const toFetch: string[] = [];
    for (const id of missing) {
      const pending = this.inflight.get(id);
      if (pending) waiting.push(pending.then((value) => void (value && result.set(id, value))));
      else toFetch.push(id);
    }
    if (toFetch.length > 0) {
      const batch = this.fetchIdentities(toFetch, now);
      for (const id of toFetch) {
        const pending = batch.then((found) => found.get(id));
        this.inflight.set(id, pending);
        void pending.finally(() => this.inflight.delete(id));
        waiting.push(pending.then((value) => void (value && result.set(id, value))));
      }
    }
    await Promise.all(waiting);
    return result;
  }

  /** One query for all the given users; never rejects (a failure yields no identities). */
  private async fetchIdentities(missing: string[], now: number): Promise<Map<string, ResolvedIdentity>> {
    const result = new Map<string, ResolvedIdentity>();
    try {
      const rows: IdentityRow[] = await this.usersRepository.query(
        `SELECT u.id AS "id",
                u.discord_global_name AS "globalName",
                u.discord_username AS "username",
                p.iracing_name AS "iracingName",
                p.display_name AS "displayName",
                p.avatar_url AS "avatarUrl"
           FROM users u
           LEFT JOIN driver_profiles p ON p.user_id = u.id::text
          WHERE u.id = ANY($1::uuid[])`,
        [missing],
      );
      this.pruneCache(now);
      for (const row of rows) {
        const value: ResolvedIdentity = {
          name:
            clean(row.iracingName) ??
            clean(row.displayName) ??
            clean(row.globalName) ??
            clean(row.username) ??
            PRESENCE_FALLBACK_NAME,
          avatarUrl: clean(row.avatarUrl),
        };
        this.identityCache.set(row.id, { value, expiresAt: now + PRESENCE_NAME_CACHE_MS });
        result.set(row.id, value);
      }
    } catch (err) {
      // Presence is cosmetic: fall back to generic names (not cached, so the next change retries).
      this.logger.warn(`Resolving presence names failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  private pruneCache(now: number): void {
    if (this.identityCache.size < 200) return;
    for (const [id, entry] of this.identityCache) {
      if (entry.expiresAt <= now) this.identityCache.delete(id);
    }
  }
}
