import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { EVENT_LINK_WINDOW_MS, ResultEventLinkService } from './result-event-link.service.js';

const HOUR = 3_600_000;
const RESULT_START = new Date('2026-10-24T12:00:00Z');

function eventTeam(id: string, over: Record<string, unknown> = {}) {
  // Default: green flag 1h after the iRacing session opened.
  const startsAt = (over.startsAt as Date | undefined) ?? new Date(RESULT_START.getTime() + HOUR);
  return {
    id,
    eventId: over.eventId ?? 'ev1',
    iracingTeamId: 100,
    timeslotId: 'slot',
    raceStartOffsetMinutes: over.raceStartOffsetMinutes ?? null,
    timeslot: over.noTimeslot ? null : { startsAt },
    event: { id: over.eventId ?? 'ev1', status: over.status ?? EventStatus.PUBLISHED },
  };
}

interface Options {
  candidates?: ReturnType<typeof eventTeam>[];
  event?: { id: string; status: EventStatus } | null;
  timeslotted?: { id: string }[];
  linkedTeamIds?: string[];
}

function makeService(opts: Options = {}) {
  const eventTeams = {
    find: vi.fn(async (query: { where: Record<string, unknown> }) =>
      'iracingTeamId' in query.where ? (opts.candidates ?? []) : (opts.timeslotted ?? []),
    ),
  };
  const events = {
    findOne: vi.fn().mockResolvedValue(opts.event === undefined ? { id: 'ev1', status: EventStatus.PUBLISHED } : opts.event),
  };
  const results = {
    update: vi.fn().mockResolvedValue(undefined),
    find: vi.fn(async () => (opts.linkedTeamIds ?? []).map((eventTeamId) => ({ id: `r-${eventTeamId}`, eventTeamId }))),
  };
  const eventsService = { update: vi.fn().mockResolvedValue(undefined) };
  const service = new ResultEventLinkService(eventTeams as never, events as never, results as never, eventsService as never);
  return { service, eventTeams, events, results, eventsService };
}

const newResult = (over: Record<string, unknown> = {}) =>
  ({ id: 'res1', teamId: 100, startTime: RESULT_START, eventId: null, eventTeamId: null, ...over }) as never;

describe('ResultEventLinkService linking', () => {
  it('links a single candidate within the window and completes nothing when another team has no result', async () => {
    const { service, results, eventsService } = makeService({
      candidates: [eventTeam('t1')],
      timeslotted: [{ id: 't1' }, { id: 't2' }],
      linkedTeamIds: ['t1'],
    });
    const result = newResult();
    await service.linkAndComplete(result);
    expect(results.update).toHaveBeenCalledWith('res1', { eventId: 'ev1', eventTeamId: 't1' });
    expect((result as { eventTeamId: string }).eventTeamId).toBe('t1');
    expect(eventsService.update).not.toHaveBeenCalled();
  });

  it('adds the race start offset to the timeslot when judging distance', async () => {
    // The timeslot opens 9h before the session; a 570 min (9.5h) offset puts the green flag 30 min after it.
    const timeslot = new Date(RESULT_START.getTime() - 9 * HOUR);
    const { service, results } = makeService({
      candidates: [eventTeam('t1', { startsAt: timeslot, raceStartOffsetMinutes: '570.00' })],
      timeslotted: [{ id: 't1' }],
      linkedTeamIds: ['t1'],
    });
    await service.linkAndComplete(newResult());
    expect(results.update).toHaveBeenCalledWith('res1', { eventId: 'ev1', eventTeamId: 't1' });
  });

  it('picks the closest of several candidates', async () => {
    const { service, results } = makeService({
      candidates: [
        eventTeam('far', { eventId: 'evA', startsAt: new Date(RESULT_START.getTime() + 5 * HOUR) }),
        eventTeam('near', { eventId: 'evB', startsAt: new Date(RESULT_START.getTime() + 20 * 60_000) }),
      ],
      event: { id: 'evB', status: EventStatus.PUBLISHED },
      timeslotted: [{ id: 'near' }],
      linkedTeamIds: ['near'],
    });
    await service.linkAndComplete(newResult());
    expect(results.update).toHaveBeenCalledWith('res1', { eventId: 'evB', eventTeamId: 'near' });
  });

  it('leaves the result unlinked when nothing is close enough, the event is DRAFT/CANCELLED, or the team has no timeslot', async () => {
    for (const candidates of [
      [eventTeam('t1', { startsAt: new Date(RESULT_START.getTime() + EVENT_LINK_WINDOW_MS + HOUR) })],
      [eventTeam('t1', { startsAt: new Date(RESULT_START.getTime() - EVENT_LINK_WINDOW_MS - HOUR) })],
      [eventTeam('t1', { status: EventStatus.DRAFT })],
      [eventTeam('t1', { status: EventStatus.CANCELLED })],
      [eventTeam('t1', { noTimeslot: true })],
      [],
    ]) {
      const { service, results, eventsService } = makeService({ candidates });
      await service.linkAndComplete(newResult());
      expect(results.update).not.toHaveBeenCalled();
      expect(eventsService.update).not.toHaveBeenCalled();
    }
  });

  it('queries the event team by either sign of the iRacing team id and does nothing without a start time', async () => {
    const { service, eventTeams, results } = makeService({ candidates: [eventTeam('t1')] });
    await service.linkAndComplete(newResult({ startTime: null }));
    expect(results.update).not.toHaveBeenCalled();
    await service.linkAndComplete(newResult());
    const where = eventTeams.find.mock.calls[0][0].where as { iracingTeamId: { value: number[] } };
    expect(where.iracingTeamId.value).toEqual([100, -100]);
  });

  it('never throws', async () => {
    const { service, eventTeams } = makeService();
    eventTeams.find.mockRejectedValue(new Error('db'));
    await expect(service.linkAndComplete(newResult())).resolves.toBeUndefined();
  });
});

describe('ResultEventLinkService completion', () => {
  it('marks the event COMPLETED when every timeslotted team has a result', async () => {
    const { service, eventsService } = makeService({
      candidates: [eventTeam('t1')],
      timeslotted: [{ id: 't1' }, { id: 't2' }],
      linkedTeamIds: ['t1', 't2'],
    });
    await service.linkAndComplete(newResult());
    expect(eventsService.update).toHaveBeenCalledWith('ev1', { status: EventStatus.COMPLETED });
  });

  it('completes PUBLISHED and SIGNUPS_CLOSED events only', async () => {
    for (const [status, expected] of [
      [EventStatus.SIGNUPS_CLOSED, 1],
      [EventStatus.PUBLISHED, 1],
      [EventStatus.COMPLETED, 0],
      [EventStatus.CANCELLED, 0],
      [EventStatus.DRAFT, 0],
    ] as const) {
      const { service, eventsService } = makeService({
        candidates: [eventTeam('t1')],
        event: { id: 'ev1', status },
        timeslotted: [{ id: 't1' }],
        linkedTeamIds: ['t1'],
      });
      await service.linkAndComplete(newResult());
      expect(eventsService.update).toHaveBeenCalledTimes(expected);
    }
  });

  it('needs at least one timeslotted team', async () => {
    const { service, eventsService } = makeService({ candidates: [eventTeam('t1')], timeslotted: [], linkedTeamIds: [] });
    await service.linkAndComplete(newResult());
    expect(eventsService.update).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-linked result is not re-linked, and a COMPLETED event is left alone', async () => {
    const { service, eventTeams, results, eventsService } = makeService({
      timeslotted: [{ id: 't1' }],
      linkedTeamIds: ['t1'],
    });
    await service.linkAndComplete(newResult({ eventId: 'ev1', eventTeamId: 't1' }));
    expect(results.update).not.toHaveBeenCalled();
    expect(eventTeams.find.mock.calls.every(([q]) => !('iracingTeamId' in q.where))).toBe(true);
    expect(eventsService.update).toHaveBeenCalledTimes(1);

    const done = makeService({
      event: { id: 'ev1', status: EventStatus.COMPLETED },
      timeslotted: [{ id: 't1' }],
      linkedTeamIds: ['t1'],
    });
    await done.service.linkAndComplete(newResult({ eventId: 'ev1', eventTeamId: 't1' }));
    expect(done.eventsService.update).not.toHaveBeenCalled();
  });
});
