import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { computeViewerStatus, withViewerStatus } from './event-viewer-status.js';
import { EventsService } from './events.service.js';

describe('computeViewerStatus', () => {
  it('is all false without a signup', () => {
    expect(computeViewerStatus(EventStatus.PUBLISHED, undefined)).toEqual({
      signedUp: false,
      onTeam: false,
      raced: false,
    });
  });

  it('treats a cancelled signup as not signed up', () => {
    const signup = { eventId: 'e', status: SignupStatus.CANCELLED, eventTeamId: 't1' };
    expect(computeViewerStatus(EventStatus.PUBLISHED, signup)).toEqual({
      signedUp: false,
      onTeam: false,
      raced: false,
    });
  });

  it('flags a signed-up driver who is not on a team yet', () => {
    const signup = { eventId: 'e', status: SignupStatus.CONFIRMED, eventTeamId: null };
    expect(computeViewerStatus(EventStatus.PUBLISHED, signup)).toEqual({
      signedUp: true,
      onTeam: false,
      raced: false,
    });
  });

  it('flags a driver placed on a team, but only marks raced once the event is completed', () => {
    const signup = { eventId: 'e', status: SignupStatus.CONFIRMED, eventTeamId: 't1' };
    expect(computeViewerStatus(EventStatus.SIGNUPS_CLOSED, signup)).toEqual({
      signedUp: true,
      onTeam: true,
      raced: false,
    });
    expect(computeViewerStatus(EventStatus.COMPLETED, signup)).toEqual({
      signedUp: true,
      onTeam: true,
      raced: true,
    });
  });

  it('does not mark raced for a completed event the driver signed up for but was never placed on', () => {
    const signup = { eventId: 'e', status: SignupStatus.CONFIRMED, eventTeamId: null };
    expect(computeViewerStatus(EventStatus.COMPLETED, signup).raced).toBe(false);
  });

  it('counts a waitlisted signup as signed up', () => {
    const signup = { eventId: 'e', status: SignupStatus.WAITLISTED, eventTeamId: null };
    expect(computeViewerStatus(EventStatus.PUBLISHED, signup).signedUp).toBe(true);
  });
});

describe('withViewerStatus', () => {
  it('matches each event to the viewer signup for that event only', () => {
    const events = [
      { id: 'a', status: EventStatus.PUBLISHED },
      { id: 'b', status: EventStatus.COMPLETED },
      { id: 'c', status: EventStatus.DRAFT },
    ];
    const signups = [
      { eventId: 'a', status: SignupStatus.CONFIRMED, eventTeamId: null },
      { eventId: 'b', status: SignupStatus.CONFIRMED, eventTeamId: 't' },
    ];
    const result = withViewerStatus(events, signups);
    expect(result.map((e) => e.viewer)).toEqual([
      { signedUp: true, onTeam: false, raced: false },
      { signedUp: true, onTeam: true, raced: true },
      { signedUp: false, onTeam: false, raced: false },
    ]);
  });
});

describe('EventsService viewer status', () => {
  function makeService(events: { id: string; status: EventStatus }[]) {
    const eventsRepository = { find: vi.fn().mockResolvedValue(events) };
    const signupsRepository = {
      find: vi.fn().mockResolvedValue([{ id: 's1', eventId: 'e2', status: SignupStatus.CONFIRMED, eventTeamId: 't1' }]),
    };
    const stub = {} as never;
    const service = new EventsService(
      eventsRepository as never,
      signupsRepository as never,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    return { service, eventsRepository, signupsRepository };
  }

  it('lists events with viewer status using a single batched signups query', async () => {
    const { service, signupsRepository } = makeService([
      { id: 'e1', status: EventStatus.PUBLISHED },
      { id: 'e2', status: EventStatus.COMPLETED },
      { id: 'e3', status: EventStatus.PUBLISHED },
    ]);

    const result = await service.findAllForViewer(false, 'user-1');

    expect(signupsRepository.find).toHaveBeenCalledTimes(1);
    expect(result.map((e) => e.viewer)).toEqual([
      { signedUp: false, onTeam: false, raced: false },
      { signedUp: true, onTeam: true, raced: true },
      { signedUp: false, onTeam: false, raced: false },
    ]);
  });

  it('skips the signups query when there are no events', async () => {
    const { service, signupsRepository } = makeService([]);
    expect(await service.findAllForViewer(true, 'user-1')).toEqual([]);
    expect(signupsRepository.find).not.toHaveBeenCalled();
  });

  it('derives the detail viewer status from the already-loaded signups', async () => {
    const { service, signupsRepository } = makeService([]);
    const event = { id: 'e2', status: EventStatus.COMPLETED, timeslots: [] };
    (service as unknown as { findRawByIdOrThrow: unknown }).findRawByIdOrThrow = vi.fn().mockResolvedValue(event);
    signupsRepository.find.mockResolvedValue([
      { id: 's1', userId: 'someone-else', status: SignupStatus.CONFIRMED, eventTeamId: 't9' },
      { id: 's2', userId: 'user-1', status: SignupStatus.CONFIRMED, eventTeamId: 't1' },
    ]);

    const detail = await service.findByIdForViewer('e2', false, 'user-1');

    expect(detail.viewer).toEqual({ signedUp: true, onTeam: true, raced: true });
    expect(detail.signups).toHaveLength(2);
    expect(signupsRepository.find).toHaveBeenCalledTimes(1);
  });
});
