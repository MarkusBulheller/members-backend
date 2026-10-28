import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamPlanEventsService, type TeamPlanMessageEvent } from '../team-plan-events.service.js';
import { FollowStreamService, MAX_FOLLOW_STREAMS_PER_TOKEN } from './follow-stream.service.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const TARGET = { teamId: 't1', eventId: 'e1' };

describe('FollowStreamService', () => {
  let plan: TeamPlanEventsService;
  let service: FollowStreamService;

  beforeEach(() => {
    vi.useFakeTimers();
    plan = new TeamPlanEventsService();
    service = new FollowStreamService(plan);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function connect(token = TOKEN) {
    const messages: TeamPlanMessageEvent[] = [];
    let completed = false;
    const subscription = service.open(token, TARGET).subscribe({
      next: (m) => messages.push(m),
      complete: () => {
        completed = true;
      },
    });
    return { messages, subscription, isCompleted: () => completed };
  }

  it('sends one unnamed {"changed":true} per burst of plan changes (debounced), with no plan data', () => {
    const { messages } = connect();
    plan.emit('e1', 't1', 'stints', 'u1');
    plan.emit('e1', 't1', 'team', 'u1');
    plan.emit('e1', '*', 'event', null);
    plan.emit('e1', 't1', 'drivers', null);
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(messages).toEqual([{ data: { changed: true } }]);

    plan.emit('e1', 't1', 'stints', 'u2');
    vi.advanceTimersByTime(500);
    expect(messages).toHaveLength(2);
  });

  it('ignores changes of other teams and events', () => {
    const { messages } = connect();
    plan.emit('e1', 't2', 'stints');
    plan.emit('e2', 't1', 'stints');
    vi.advanceTimersByTime(2_000);
    expect(messages).toEqual([]);
  });

  it('nudges open pages when the display settings change', () => {
    const { messages } = connect();
    service.notifyChanged('t1');
    service.notifyChanged('t2');
    vi.advanceTimersByTime(500);
    expect(messages).toEqual([{ data: { changed: true } }]);
  });

  it('sends the heartbeat event every 25s', () => {
    const { messages } = connect();
    vi.advanceTimersByTime(25_000);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('heartbeat');
  });

  it('sends {"revoked":true} once and completes the stream when the link is revoked', () => {
    const conn = connect();
    plan.emit('e1', 't1', 'stints'); // a pending nudge must not outlive the stream
    service.notifyRevoked('t1');
    expect(conn.messages).toEqual([{ data: { revoked: true } }]);
    expect(conn.isCompleted()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(conn.messages).toEqual([{ data: { revoked: true } }]);
    expect(service.openCount(TOKEN)).toBe(0);
  });

  it('a revocation of another team does not touch this stream', () => {
    const conn = connect();
    service.notifyRevoked('t2');
    expect(conn.isCompleted()).toBe(false);
    expect(conn.messages).toEqual([]);
  });

  it('caps concurrent streams per token (429) and frees a slot on disconnect', () => {
    const open = Array.from({ length: MAX_FOLLOW_STREAMS_PER_TOKEN }, () => connect());
    expect(service.openCount(TOKEN)).toBe(MAX_FOLLOW_STREAMS_PER_TOKEN);

    let error: unknown;
    try {
      service.open(TOKEN, TARGET);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    // the rejected attempt must not have taken a slot
    expect(service.openCount(TOKEN)).toBe(MAX_FOLLOW_STREAMS_PER_TOKEN);

    // another link is unaffected
    expect(() => connect('other-token-other-token-other-1')).not.toThrow();

    open[0].subscription.unsubscribe();
    expect(service.openCount(TOKEN)).toBe(MAX_FOLLOW_STREAMS_PER_TOKEN - 1);
    expect(() => connect()).not.toThrow();
  });

  it('cleans up fully on disconnect: no subscription, no timers left', () => {
    const conn = connect();
    conn.subscription.unsubscribe();
    expect(service.openCount(TOKEN)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    plan.emit('e1', 't1', 'stints');
    vi.advanceTimersByTime(60_000);
    expect(conn.messages).toEqual([]);
  });

  it('frees a reserved slot whose stream was never subscribed', () => {
    service.open(TOKEN, TARGET); // reserved, never subscribed
    expect(service.openCount(TOKEN)).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(service.openCount(TOKEN)).toBe(0);
  });
});
