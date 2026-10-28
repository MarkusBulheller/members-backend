import { describe, expect, it, vi } from 'vitest';
import { EventStatus } from '../common/enums/event-status.enum.js';
import { EventsService } from './events.service.js';

/** The dashboard's "next stint" must count from the GREEN FLAG (timeslot start + the team's
 * race-start offset), exactly like the plan page — not from the timeslot's own start. */
describe('EventsService.findUpcomingStintAssignmentsForUser — race start offset', () => {
  const HOUR = 3_600_000;
  const timeslotStart = new Date(Date.now() + 2 * HOUR);

  function build(offsetMinutes: string | null) {
    const team = {
      id: 't1',
      name: 'Red',
      eventId: 'e1',
      refuelDurationSeconds: '0',
      pitstopDrivethroughSeconds: '0',
      tyreChangeDurationSeconds: '0',
      raceStartOffsetMinutes: offsetMinutes,
      timeslot: { startsAt: timeslotStart },
      event: { id: 'e1', title: 'Test', status: EventStatus.SIGNUPS_CLOSED, raceLengthMinutes: 240, sim: 'IRACING' },
    };
    const stints = [
      { id: 's1', eventTeamId: 't1', order: 0, driverUserId: 'u1', durationMinutes: '60', tyreChange: false, actualStartAt: null, eventTeam: team },
      { id: 's2', eventTeamId: 't1', order: 1, driverUserId: 'u2', durationMinutes: '60', tyreChange: false, actualStartAt: null, eventTeam: team },
    ];
    const service = Object.create(EventsService.prototype) as unknown as {
      eventTeamStintsRepository: { find: ReturnType<typeof vi.fn> };
      findUpcomingStintAssignmentsForUser(userId: string): Promise<
        { raceStartsAt: string | null; timeslotStartsAt: string | null; nextStintStartsAt: string | null; isLive: boolean }[]
      >;
    };
    service.eventTeamStintsRepository = {
      // first call: this driver's own stints (with relations); second: the whole team's stints in order
      find: vi
        .fn()
        .mockResolvedValueOnce(stints.filter((s) => s.driverUserId === 'u1'))
        .mockResolvedValueOnce(stints),
    };
    return service;
  }

  it('anchors the first stint at timeslot start + offset', async () => {
    const service = build('90');
    const [assignment] = await service.findUpcomingStintAssignmentsForUser('u1');
    const expectedRaceStart = timeslotStart.getTime() + 90 * 60_000;
    expect(assignment.timeslotStartsAt).toBe(timeslotStart.toISOString());
    expect(assignment.raceStartsAt).toBe(new Date(expectedRaceStart).toISOString());
    expect(assignment.nextStintStartsAt).toBe(new Date(expectedRaceStart).toISOString());
  });

  it('without an offset the green flag is the timeslot start', async () => {
    const service = build(null);
    const [assignment] = await service.findUpcomingStintAssignmentsForUser('u1');
    expect(assignment.raceStartsAt).toBe(timeslotStart.toISOString());
    expect(assignment.nextStintStartsAt).toBe(timeslotStart.toISOString());
  });

  it('is not live during the practice/qualifying block before the green flag', async () => {
    const service = build('180');
    const [assignment] = await service.findUpcomingStintAssignmentsForUser('u1');
    expect(assignment.isLive).toBe(false);
  });
});
