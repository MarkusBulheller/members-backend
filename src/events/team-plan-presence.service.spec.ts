import { merge } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { TeamPlanEventsService, type TeamPlanMessageEvent } from './team-plan-events.service.js';
import {
  PRESENCE_DEBOUNCE_MS,
  PRESENCE_FALLBACK_NAME,
  PRESENCE_MAX_USERS,
  PRESENCE_NAME_CACHE_MS,
  type PresenceUser,
  TeamPlanPresenceService,
} from './team-plan-presence.service.js';
import { TeamPlanStreamController } from './team-plan-stream.controller.js';

interface Row {
  id: string;
  globalName?: string | null;
  username?: string | null;
  iracingName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

function setup(rows: Row[] = []) {
  const query = vi.fn((_sql: string, params: [string[]]) =>
    Promise.resolve(
      params[0].flatMap((id) => {
        const row = rows.find((r) => r.id === id);
        return row
          ? [{ globalName: null, username: null, iracingName: null, displayName: null, avatarUrl: null, ...row }]
          : [];
      }),
    ),
  );
  const service = new TeamPlanPresenceService({ query } as never);
  return { service, query };
}

/** Subscribes like the SSE layer would; returns the received lists and the unsubscribe. */
function open(service: TeamPlanPresenceService, userId: string, isAdmin = false, eventId = 'e1', teamId = 't1') {
  const messages: TeamPlanMessageEvent[] = [];
  const sub = service.connect(eventId, teamId, { userId, isAdmin }).subscribe((m) => messages.push(m));
  const lists = () => messages.map((m) => JSON.parse(m.data as string) as PresenceUser[]);
  return { messages, lists, sub };
}

const names = (list: PresenceUser[]) => list.map((u) => u.name);

describe('TeamPlanPresenceService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rows: Row[] = [
    { id: 'u1', iracingName: 'Alex Rivera', displayName: 'Alex', avatarUrl: '/uploads/avatars/a.png' },
    { id: 'u2', displayName: 'Bea' },
    { id: 'u3', globalName: 'Cy Global', username: 'cy' },
    { id: 'u4', username: 'dee' },
  ];

  it('sends a named `presence` snapshot immediately to a new connection', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1', true);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.messages).toHaveLength(1);
    expect(a.messages[0].type).toBe('presence');
    expect(typeof a.messages[0].data).toBe('string'); // the wire payload is a JSON array
    expect(a.lists()[0]).toEqual([
      { userId: 'u1', name: 'Alex Rivera', avatarUrl: '/uploads/avatars/a.png', isAdmin: true },
    ]);
    a.sub.unsubscribe();
  });

  it('resolves names iracingName, displayName, Discord global name, username, then a fallback', async () => {
    const { service } = setup(rows);
    const all = ['u1', 'u2', 'u3', 'u4', 'ghost'].map((id) => open(service, id));
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);

    const last = all[0].lists().at(-1)!;
    expect(names(last)).toEqual(['Alex Rivera', 'Bea', 'Cy Global', 'dee', PRESENCE_FALLBACK_NAME]);
    expect(last[1].avatarUrl).toBeNull();
    all.forEach((c) => c.sub.unsubscribe());
  });

  it('ignores blank names and falls through to the next source', async () => {
    const { service } = setup([{ id: 'u1', iracingName: '  ', displayName: '', globalName: 'Glob', username: 'g' }]);
    const a = open(service, 'u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.lists()[0][0].name).toBe('Glob');
    a.sub.unsubscribe();
  });

  it('falls back to generic names when the lookup fails, without caching the failure', async () => {
    const { service, query } = setup(rows);
    query.mockRejectedValueOnce(new Error('db down'));
    const a = open(service, 'u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.lists()[0][0].name).toBe(PRESENCE_FALLBACK_NAME);

    const b = open(service, 'u2');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(names(a.lists().at(-1)!)).toEqual(['Alex Rivera', 'Bea']);
    a.sub.unsubscribe();
    b.sub.unsubscribe();
  });

  it('counts one user with several tabs once and only drops them after the last tab closes', async () => {
    const { service } = setup(rows);
    const watcher = open(service, 'u2');
    const tab1 = open(service, 'u1');
    const tab2 = open(service, 'u1');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(names(watcher.lists().at(-1)!)).toEqual(['Bea', 'Alex Rivera']);

    tab1.sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS * 2);
    expect(names(watcher.lists().at(-1)!)).toEqual(['Bea', 'Alex Rivera']); // still there via tab2

    tab2.sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(names(watcher.lists().at(-1)!)).toEqual(['Bea']);
    watcher.sub.unsubscribe();
  });

  it('does not broadcast when a second tab of an already-present user opens', async () => {
    const { service } = setup(rows);
    const watcher = open(service, 'u2');
    const tab1 = open(service, 'u1');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    const before = watcher.messages.length;

    const tab2 = open(service, 'u1'); // gets its own snapshot, nobody else is told
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS * 2);
    expect(watcher.messages).toHaveLength(before);
    expect(tab2.messages).toHaveLength(1);
    [watcher, tab1, tab2].forEach((c) => c.sub.unsubscribe());
  });

  it('broadcasts joins and leaves to the others, debounced into one message', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.messages).toHaveLength(1);

    const b = open(service, 'u2');
    const c = open(service, 'u3');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS - 1);
    expect(a.messages).toHaveLength(1); // still inside the window
    await vi.advanceTimersByTimeAsync(1);
    expect(a.messages).toHaveLength(2); // one message for both joins
    expect(names(a.lists()[1])).toEqual(['Alex Rivera', 'Bea', 'Cy Global']);

    // b already has its own snapshot; the broadcast adds the later joiner once.
    expect(names(b.lists().at(-1)!)).toEqual(['Alex Rivera', 'Bea', 'Cy Global']);

    b.sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(names(a.lists().at(-1)!)).toEqual(['Alex Rivera', 'Cy Global']);
    expect(names(c.lists().at(-1)!)).toEqual(['Alex Rivera', 'Cy Global']);
    a.sub.unsubscribe();
    c.sub.unsubscribe();
  });

  it('suppresses a reconnect flap (leave + rejoin inside the debounce window)', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1');
    const b = open(service, 'u2');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    const before = a.messages.length;

    b.sub.unsubscribe();
    const b2 = open(service, 'u2'); // reconnects immediately
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS * 2);
    // Order changed (Bea re-joined last) but the set is the same two people; at most one update.
    expect(a.messages.length - before).toBeLessThanOrEqual(1);
    expect(names(a.lists().at(-1)!).sort()).toEqual(['Alex Rivera', 'Bea']);
    a.sub.unsubscribe();
    b2.sub.unsubscribe();
  });

  it('keeps teams and events separate', async () => {
    const { service } = setup(rows);
    const t1 = open(service, 'u1', false, 'e1', 't1');
    const t2 = open(service, 'u2', false, 'e1', 't2');
    const other = open(service, 'u3', false, 'e2', 't1');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS * 2);
    expect(names(t1.lists().at(-1)!)).toEqual(['Alex Rivera']);
    expect(names(t2.lists().at(-1)!)).toEqual(['Bea']);
    expect(names(other.lists().at(-1)!)).toEqual(['Cy Global']);
    [t1, t2, other].forEach((c) => c.sub.unsubscribe());
  });

  it('caps the list at 25 people', async () => {
    const many = Array.from({ length: PRESENCE_MAX_USERS + 5 }, (_, i) => ({ id: `m${i}`, displayName: `M${i}` }));
    const { service } = setup(many);
    const conns = many.map((r) => open(service, r.id));
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    const list = conns[0].lists().at(-1)!;
    expect(list).toHaveLength(PRESENCE_MAX_USERS);
    expect(list[0].userId).toBe('m0'); // join order
    conns.forEach((c) => c.sub.unsubscribe());
  });

  it('batches a name lookup into one query and caches names for 60s', async () => {
    const { service, query } = setup(rows);
    const a = open(service, 'u1');
    const b = open(service, 'u2');
    const c = open(service, 'u3');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    // 3 immediate snapshots + 1 broadcast; each only queries ids not already cached.
    const idsQueried = query.mock.calls.flatMap((call) => call[1][0]).sort();
    expect(idsQueried).toEqual(['u1', 'u2', 'u3']); // every id fetched exactly once

    const callsBefore = query.mock.calls.length;
    c.sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(query.mock.calls.length).toBe(callsBefore); // all cached

    await vi.advanceTimersByTimeAsync(PRESENCE_NAME_CACHE_MS);
    const d = open(service, 'u4');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    const last = query.mock.calls.at(-1)![1][0];
    expect(last.sort()).toEqual(['u1', 'u2', 'u4']); // expired entries looked up again, in one query
    [a, b, d].forEach((x) => x.sub.unsubscribe());
  });

  it('cleans up: no rooms, timers or connections remain after everyone leaves', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1');
    const b = open(service, 'u2');
    expect(service.roomCount).toBe(1);

    a.sub.unsubscribe();
    expect(vi.getTimerCount()).toBe(1); // a pending broadcast for b
    b.sub.unsubscribe();
    expect(service.roomCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const internals = service as unknown as { rooms: Map<string, unknown> };
    expect(internals.rooms.size).toBe(0);
    await expect(service.current('e1', 't1')).resolves.toEqual([]);
  });

  it('does not deliver a late-resolving snapshot to a connection that already left', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1');
    a.sub.unsubscribe(); // before the name lookup resolves
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(a.messages).toHaveLength(0);
    expect(service.roomCount).toBe(0);
  });

  it('unsubscribing twice is harmless and a re-opened room starts fresh', async () => {
    const { service } = setup(rows);
    const a = open(service, 'u1');
    a.sub.unsubscribe();
    a.sub.unsubscribe();
    const b = open(service, 'u2');
    await vi.advanceTimersByTimeAsync(PRESENCE_DEBOUNCE_MS);
    expect(names(b.lists().at(-1)!)).toEqual(['Bea']);
    b.sub.unsubscribe();
    expect(service.roomCount).toBe(0);
  });
});

describe('presence on the plan SSE stream (controller wiring)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('merges presence with change notices and heartbeats, and unregisters the viewer on disconnect', async () => {
    const { service } = setup([{ id: 'u1', displayName: 'Alex' }]);
    const planEvents = new TeamPlanEventsService();
    const controller = new TeamPlanStreamController(
      planEvents,
      { findOne: vi.fn().mockResolvedValue({ id: 'e1', status: EventStatus.PUBLISHED }) } as never,
      { findOne: vi.fn().mockResolvedValue({ id: 't1' }) } as never,
      service,
    );

    const stream = await controller.stream('e1', 't1', { id: 'u1', role: Role.ADMIN } as never);
    const messages: TeamPlanMessageEvent[] = [];
    const sub = stream.subscribe((m) => messages.push(m));
    await vi.advanceTimersByTimeAsync(0);

    expect(messages.map((m) => m.type)).toEqual(['presence']);
    expect(JSON.parse(messages[0].data as string)).toEqual([
      { userId: 'u1', name: 'Alex', avatarUrl: null, isAdmin: true },
    ]);

    planEvents.emit('e1', 't1', 'stints', 'u9');
    expect(messages.at(-1)!.type).toBeUndefined(); // change notices stay unnamed -> onmessage
    await vi.advanceTimersByTimeAsync(25_000);
    expect(messages.some((m) => m.type === 'heartbeat')).toBe(true);

    sub.unsubscribe(); // what Nest does when the client socket closes
    expect(service.roomCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merge() teardown also stops presence for a viewer that disconnects mid-stream', () => {
    const { service } = setup([]);
    const sub = merge(service.connect('e1', 't1', { userId: 'u1', isAdmin: false })).subscribe();
    expect(service.roomCount).toBe(1);
    sub.unsubscribe();
    expect(service.roomCount).toBe(0);
  });
});
