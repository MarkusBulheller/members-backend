import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { EventsService } from './events.service.js';
import { normalizeTimeslotPreference } from './timeslot-preference.js';

const slot = (id: string, iso: string) => ({ id, startsAt: new Date(iso) });
const A = slot('a', '2026-11-01T13:00:00Z');
const B = slot('b', '2026-11-01T17:00:00Z');
const C = slot('c', '2026-11-01T21:00:00Z');

describe('normalizeTimeslotPreference', () => {
  it('keeps a full permutation as given', () => {
    expect(normalizeTimeslotPreference(['c', 'a', 'b'], [A, B, C])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('drops ids that were not chosen and dedupes', () => {
    expect(normalizeTimeslotPreference(['x', 'c', 'c', 'a'], [A, C])).toEqual([
      'c',
      'a',
    ]);
  });

  it('appends missing chosen slots in chronological order', () => {
    // chosen passed out of order; B and A are missing from the request
    expect(normalizeTimeslotPreference(['c'], [C, B, A])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('falls back to chronological order with no request', () => {
    expect(normalizeTimeslotPreference(undefined, [C, A, B])).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(normalizeTimeslotPreference(null, [B, A])).toEqual(['a', 'b']);
    expect(normalizeTimeslotPreference([], [B, A])).toEqual(['a', 'b']);
  });

  it('is null when no slots are chosen', () => {
    expect(normalizeTimeslotPreference(['a'], [])).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const chosen = [C, A];
    normalizeTimeslotPreference(['c'], chosen);
    expect(chosen).toEqual([C, A]);
  });
});

function makeService(existing: Record<string, unknown> | null) {
  const event = {
    id: 'ev1',
    status: EventStatus.PUBLISHED,
    carClasses: ['GT3'],
    raceLengthMinutes: 60,
    timeslots: [A, B, C],
  };
  const eventsRepository = { findOneOrFail: vi.fn().mockResolvedValue(event) };
  const signupsRepository = {
    findOne: vi.fn().mockResolvedValue(existing),
    create: vi.fn().mockImplementation((v) => v),
    save: vi.fn().mockImplementation(async (s) => s),
  };
  const timeslotsRepository = {
    find: vi
      .fn()
      .mockImplementation(
        async ({ where }: { where: { id: { value: string[] } } }) => {
          const ids: string[] = where.id.value;
          return [A, B, C].filter((s) => ids.includes(s.id));
        },
      ),
  };
  const stub = {} as never;
  const service = new EventsService(
    eventsRepository as never,
    signupsRepository as never,
    timeslotsRepository as never,
    stub,
    stub,
    stub,
    stub,
    {
      postEventAnnouncement: vi.fn(),
      updateEventAnnouncement: vi.fn(),
    } as never,
  );
  // saveSignup would schedule a Discord timer; keep these tests timer-free.
  (service as unknown as Record<string, unknown>).scheduleAnnouncementRefresh = () => undefined;
  return { service, signupsRepository };
}

describe('EventsService.signup timeslot preference', () => {
  it('stores a normalised ranking for a new signup', async () => {
    const { service } = makeService(null);
    const saved = await service.signup('ev1', 'u1', {
      timeslotIds: ['a', 'c'],
      timeslotPreference: ['c', 'zzz'],
    });
    expect(saved.timeslotPreference).toEqual(['c', 'a']);
    expect(saved.timeslots.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('leaves the ranking null when none is sent', async () => {
    const { service } = makeService(null);
    const saved = await service.signup('ev1', 'u1', {
      timeslotIds: ['a', 'c'],
    });
    expect(saved.timeslotPreference ?? null).toBeNull();
  });

  it('re-normalises a stored ranking when the chosen slots change', async () => {
    const existing = {
      id: 's1',
      eventId: 'ev1',
      userId: 'u1',
      status: SignupStatus.CONFIRMED,
      timeslots: [A, B, C],
      timeslotPreference: ['c', 'b', 'a'],
    };
    const { service } = makeService(existing);
    const saved = await service.signup('ev1', 'u1', {
      timeslotIds: ['a', 'c'],
    });
    expect(saved.timeslotPreference).toEqual(['c', 'a']);
  });

  it('keeps the stored ranking untouched when neither slots nor ranking are sent', async () => {
    const existing = {
      id: 's1',
      eventId: 'ev1',
      userId: 'u1',
      status: SignupStatus.CONFIRMED,
      timeslots: [A, C],
      timeslotPreference: ['c', 'a'],
    };
    const { service } = makeService(existing);
    const saved = await service.signup('ev1', 'u1', { notes: 'hi' });
    expect(saved.timeslotPreference).toEqual(['c', 'a']);
  });

  it('normalises a ranking-only update against the existing slots, and null clears it', async () => {
    const existing = {
      id: 's1',
      eventId: 'ev1',
      userId: 'u1',
      status: SignupStatus.CONFIRMED,
      timeslots: [A, B],
      timeslotPreference: null,
    };
    const { service } = makeService(existing);
    expect(
      (await service.signup('ev1', 'u1', { timeslotPreference: ['b', 'c'] }))
        .timeslotPreference,
    ).toEqual(['b', 'a']);
    expect(
      (await service.signup('ev1', 'u1', { timeslotPreference: null }))
        .timeslotPreference,
    ).toBeNull();
  });
});
