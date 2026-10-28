import { describe, expect, it, vi } from 'vitest';
import { SignupStatus } from '../common/enums/signup-status.enum.js';
import { EventsService } from './events.service.js';

const EVENT = '11111111-1111-4111-8111-111111111111';
const CREW_A = '22222222-2222-4222-8222-222222222222';
const CREW_B = '33333333-3333-4333-8333-333333333333';
const SIGNUP = '44444444-4444-4444-8444-444444444444';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** An EventsService where only the signup / crew / lead repositories matter; the rest is inert. */
function makeService(opts: { signup?: Record<string, unknown> | null; leadDeleteFails?: boolean } = {}) {
  const signup =
    opts.signup === undefined
      ? { id: SIGNUP, eventId: EVENT, userId: USER, eventTeamId: CREW_A, status: SignupStatus.CONFIRMED }
      : opts.signup && { ...opts.signup };
  const signupsRepository = {
    findOne: vi.fn().mockResolvedValue(signup),
    save: vi.fn(async (s: unknown) => s),
    delete: vi.fn().mockResolvedValue({ affected: signup ? 1 : 0 }),
  };
  const eventTeamsRepository = { findOne: vi.fn().mockResolvedValue({ id: CREW_B, eventId: EVENT }) };
  const leads = {
    delete: opts.leadDeleteFails ? vi.fn().mockRejectedValue(new Error('db down')) : vi.fn().mockResolvedValue({ affected: 1 }),
  };
  const stub = {} as never;
  const service = new EventsService(
    stub,
    signupsRepository as never,
    stub,
    eventTeamsRepository as never,
    stub,
    stub,
    stub,
    stub,
    undefined,
    undefined,
    leads as never,
  );
  // Announcement refresh is a debounced timer, irrelevant here.
  (service as unknown as { scheduleAnnouncementRefresh: () => void }).scheduleAnnouncementRefresh = vi.fn();
  return { service, signupsRepository, leads };
}

describe('EventsService: lead cleanup when a driver leaves a crew', () => {
  it('moving a signup to another crew drops the lead row of the crew they left', async () => {
    const { service, leads } = makeService();
    await service.assignSignupTeam(EVENT, SIGNUP, CREW_B);
    expect(leads.delete).toHaveBeenCalledWith({ eventTeamId: CREW_A, userId: USER });
  });

  it('unplacing a signup (team null) drops the lead row', async () => {
    const { service, leads } = makeService();
    await service.assignSignupTeam(EVENT, SIGNUP, null);
    expect(leads.delete).toHaveBeenCalledWith({ eventTeamId: CREW_A, userId: USER });
  });

  it('re-assigning to the same crew or placing a previously unplaced signup keeps leads untouched', async () => {
    const same = makeService();
    same.signupsRepository.findOne.mockResolvedValue({ id: SIGNUP, eventId: EVENT, userId: USER, eventTeamId: CREW_B });
    await same.service.assignSignupTeam(EVENT, SIGNUP, CREW_B);
    expect(same.leads.delete).not.toHaveBeenCalled();

    const fresh = makeService({ signup: { id: SIGNUP, eventId: EVENT, userId: USER, eventTeamId: null } });
    await fresh.service.assignSignupTeam(EVENT, SIGNUP, CREW_B);
    expect(fresh.leads.delete).not.toHaveBeenCalled();
  });

  it('cancelling your own signup drops the lead row', async () => {
    const { service, leads } = makeService();
    await service.cancelSignup(EVENT, USER);
    expect(leads.delete).toHaveBeenCalledWith({ eventTeamId: CREW_A, userId: USER });
  });

  it('an admin override to CANCELLED drops the lead row; other statuses do not', async () => {
    const cancelled = makeService();
    await cancelled.service.adminOverrideSignup(SIGNUP, SignupStatus.CANCELLED);
    expect(cancelled.leads.delete).toHaveBeenCalledWith({ eventTeamId: CREW_A, userId: USER });

    const confirmed = makeService();
    await confirmed.service.adminOverrideSignup(SIGNUP, SignupStatus.CONFIRMED);
    expect(confirmed.leads.delete).not.toHaveBeenCalled();
  });

  it('deleting a signup drops the lead row of the crew it sat on', async () => {
    const { service, leads, signupsRepository } = makeService();
    await service.deleteSignup(EVENT, SIGNUP);
    expect(signupsRepository.delete).toHaveBeenCalledWith({ id: SIGNUP, eventId: EVENT });
    expect(leads.delete).toHaveBeenCalledWith({ eventTeamId: CREW_A, userId: USER });
  });

  it('a signup that is on no crew has nothing to clean up', async () => {
    const { service, leads } = makeService({
      signup: { id: SIGNUP, eventId: EVENT, userId: USER, eventTeamId: null, status: SignupStatus.CONFIRMED },
    });
    await service.cancelSignup(EVENT, USER);
    await service.deleteSignup(EVENT, SIGNUP);
    expect(leads.delete).not.toHaveBeenCalled();
  });

  it('is best effort: a failing lead cleanup never fails the signup change', async () => {
    const { service } = makeService({ leadDeleteFails: true });
    await expect(service.assignSignupTeam(EVENT, SIGNUP, CREW_B)).resolves.toBeDefined();
  });
});
