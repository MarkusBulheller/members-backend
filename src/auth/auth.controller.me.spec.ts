import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';

describe('AuthController.me', () => {
  const user = { id: 'u1', discordId: 'd1', role: 'MEMBER', status: 'APPROVED', tokenVersion: 3 };
  const TEAM_A = '22222222-2222-4222-8222-222222222222';
  const TEAM_B = '33333333-3333-4333-8333-333333333333';

  it('keeps the existing shape (minus tokenVersion) and adds leadOfEventTeamIds', async () => {
    const teamLeads = { eventTeamIdsLedBy: vi.fn().mockResolvedValue([TEAM_A, TEAM_B]) };
    const controller = new AuthController({} as never, {} as never, {} as never, {} as never, teamLeads as never);
    const result = await controller.me(user as never);
    expect(result).toEqual({
      id: 'u1',
      discordId: 'd1',
      role: 'MEMBER',
      status: 'APPROVED',
      leadOfEventTeamIds: [TEAM_A, TEAM_B],
    });
    expect(result).not.toHaveProperty('tokenVersion');
    expect(result).not.toHaveProperty('leadOfTeamIds');
    expect(teamLeads.eventTeamIdsLedBy).toHaveBeenCalledWith('u1');
  });

  it('returns an empty list for someone who leads nothing', async () => {
    const teamLeads = { eventTeamIdsLedBy: vi.fn().mockResolvedValue([]) };
    const controller = new AuthController({} as never, {} as never, {} as never, {} as never, teamLeads as never);
    await expect(controller.me(user as never)).resolves.toMatchObject({ leadOfEventTeamIds: [] });
  });
});
