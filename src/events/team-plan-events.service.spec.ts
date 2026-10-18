import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { Role } from '../common/enums/role.enum.js';
import { EventTeamStintsService } from './event-team-stints.service.js';
import {
  ALL_TEAMS,
  HEARTBEAT_INTERVAL_MS,
  type TeamPlanChange,
  TeamPlanEventsService,
  type TeamPlanMessageEvent,
} from './team-plan-events.service.js';
import { TeamPlanStreamController } from './team-plan-stream.controller.js';

describe('TeamPlanEventsService', () => {
  it('delivers only changes for the subscribed event and team', () => {
    const service = new TeamPlanEventsService();
    const seen: TeamPlanChange[] = [];
    service.stream('e1', 't1').subscribe((c) => seen.push(c));

    service.emit('e1', 't1', 'stints', 'u1');
    service.emit('e1', 't2', 'stints', 'u1'); // other team
    service.emit('e2', 't1', 'stints', 'u1'); // other event

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ eventId: 'e1', teamId: 't1', kind: 'stints', byUserId: 'u1' });
    expect(Number.isNaN(Date.parse(seen[0].at))).toBe(false);
  });

  it('delivers a wildcard (event-level) change to every team of that event only', () => {
    const service = new TeamPlanEventsService();
    const t1: TeamPlanChange[] = [];
    const t2: TeamPlanChange[] = [];
    const other: TeamPlanChange[] = [];
    service.stream('e1', 't1').subscribe((c) => t1.push(c));
    service.stream('e1', 't2').subscribe((c) => t2.push(c));
    service.stream('e2', 't9').subscribe((c) => other.push(c));

    service.emit('e1', ALL_TEAMS, 'event');

    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    expect(t1[0]).toMatchObject({ kind: 'event', byUserId: null });
    expect(other).toHaveLength(0);
  });

  it('stops delivering after unsubscribe and releases the subscriber', () => {
    const service = new TeamPlanEventsService();
    const seen: TeamPlanChange[] = [];
    const sub = service.stream('e1', 't1').subscribe((c) => seen.push(c));
    service.emit('e1', 't1', 'team');
    sub.unsubscribe();
    service.emit('e1', 't1', 'team');

    expect(seen).toHaveLength(1);
    expect((service as unknown as { changes: { observed: boolean } }).changes.observed).toBe(false);
  });

  it('emit with no subscribers is a harmless no-op', () => {
    const service = new TeamPlanEventsService();
    expect(() => service.emit('e1', 't1', 'stints')).not.toThrow();
  });

  describe('sse()', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('wraps changes as JSON-able messages and sends a named heartbeat every 25s', () => {
      const service = new TeamPlanEventsService();
      const messages: TeamPlanMessageEvent[] = [];
      const sub = service.sse('e1', 't1').subscribe((m) => messages.push(m));

      service.emit('e1', 't1', 'drivers', 'u1');
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBeUndefined(); // unnamed -> EventSource.onmessage
      expect(JSON.parse(JSON.stringify(messages[0].data))).toMatchObject({ kind: 'drivers', byUserId: 'u1' });

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(messages).toHaveLength(2);
      expect(messages[1].type).toBe('heartbeat');

      sub.unsubscribe();
      // Teardown clears the interval and detaches from the subject.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      service.emit('e1', 't1', 'drivers');
      expect(messages).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('emission from stint mutations', () => {
  function setup(existing: Record<string, unknown> | null = null) {
    const stintsRepository = {
      maximum: vi.fn().mockResolvedValue(null),
      create: vi.fn((v: Record<string, unknown>) => v),
      save: vi.fn((v: unknown) => Promise.resolve(v)),
      findOne: vi.fn().mockResolvedValue(existing),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const teamsRepository = { findOne: vi.fn().mockResolvedValue({ id: 't1', eventId: 'e1' }) };
    const planEvents = { emit: vi.fn() };
    const service = new EventTeamStintsService(stintsRepository as never, teamsRepository as never, planEvents as never);
    return { service, planEvents };
  }

  it('emits a stints change with the actor after create, update and remove', async () => {
    const { service, planEvents } = setup({ id: 's1', tyreChange: true, tyresChanged: 4 });
    await service.create('e1', 't1', {}, 'u1');
    await service.update('e1', 't1', 's1', { durationMinutes: 30 }, 'u2');
    await service.remove('e1', 't1', 's1', 'u3');

    expect(planEvents.emit).toHaveBeenNthCalledWith(1, 'e1', 't1', 'stints', 'u1');
    expect(planEvents.emit).toHaveBeenNthCalledWith(2, 'e1', 't1', 'stints', 'u2');
    expect(planEvents.emit).toHaveBeenNthCalledWith(3, 'e1', 't1', 'stints', 'u3');
  });

  it('does not emit when the write fails', async () => {
    const { service, planEvents } = setup(null); // stint not found
    await expect(service.update('e1', 't1', 'missing', {}, 'u1')).rejects.toThrow();
    expect(planEvents.emit).not.toHaveBeenCalled();
  });

  it('still works without the events service (older constructions)', async () => {
    const stintsRepository = {
      maximum: vi.fn().mockResolvedValue(null),
      create: vi.fn((v: Record<string, unknown>) => v),
      save: vi.fn((v: unknown) => Promise.resolve(v)),
    };
    const teamsRepository = { findOne: vi.fn().mockResolvedValue({ id: 't1', eventId: 'e1' }) };
    const service = new EventTeamStintsService(stintsRepository as never, teamsRepository as never);
    await expect(service.create('e1', 't1', {})).resolves.toBeDefined();
  });
});

describe('TeamPlanStreamController', () => {
  function setup(event: unknown, team: unknown) {
    const planEvents = new TeamPlanEventsService();
    const sse = vi.spyOn(planEvents, 'sse');
    const controller = new TeamPlanStreamController(
      planEvents,
      { findOne: vi.fn().mockResolvedValue(event) } as never,
      { findOne: vi.fn().mockResolvedValue(team) } as never,
    );
    return { controller, sse };
  }
  const member = { id: 'u1', role: Role.MEMBER } as never;
  const admin = { id: 'u2', role: Role.ADMIN } as never;

  it('opens the stream for a visible event and a team of that event', async () => {
    const { controller, sse } = setup({ id: 'e1', status: EventStatus.SIGNUPS_CLOSED }, { id: 't1' });
    await expect(controller.stream('e1', 't1', member)).resolves.toBeDefined();
    expect(sse).toHaveBeenCalledWith('e1', 't1');
  });

  it('hides a DRAFT event from members but not admins', async () => {
    const draft = { id: 'e1', status: EventStatus.DRAFT };
    await expect(setup(draft, { id: 't1' }).controller.stream('e1', 't1', member)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(setup(draft, { id: 't1' }).controller.stream('e1', 't1', admin)).resolves.toBeDefined();
  });

  it('404s when the team is not part of the event', async () => {
    const { controller, sse } = setup({ id: 'e1', status: EventStatus.PUBLISHED }, null);
    await expect(controller.stream('e1', 't9', member)).rejects.toBeInstanceOf(NotFoundException);
    expect(sse).not.toHaveBeenCalled();
  });
});
