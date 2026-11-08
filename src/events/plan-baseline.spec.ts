import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TEAM_MANAGE_KEY, TeamManageGuard } from '../auth/team-manage.guard.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { type PlanBaseline, driftSecondsAgainst } from './plan-baseline.js';
import { PlanBaselineController } from './plan-baseline.controller.js';
import { PlanBaselineService } from './plan-baseline.service.js';

const at = (iso: string) => new Date(iso);
const baseline: PlanBaseline = {
  takenAt: '2026-10-24T12:00:00.000Z',
  source: 'AUTO',
  stints: [
    { id: 's1', startsAt: '2026-10-24T13:00:00.000Z', endsAt: '2026-10-24T14:00:00.000Z' },
    { id: 's2', startsAt: '2026-10-24T14:01:00.000Z', endsAt: '2026-10-24T15:01:00.000Z' },
    { id: 's3', startsAt: '2026-10-24T15:02:00.000Z', endsAt: '2026-10-24T16:02:00.000Z' },
  ],
};

describe('driftSecondsAgainst', () => {
  it('is the delay of the latest started stint against the original plan (+ = behind)', () => {
    const stints = [
      { id: 's1', actualStartAt: at('2026-10-24T13:00:30.000Z') },
      { id: 's2', actualStartAt: at('2026-10-24T14:03:00.000Z') },
      { id: 's3', actualStartAt: null },
    ];
    expect(driftSecondsAgainst(stints, baseline)).toBe(120); // stint 2: 14:03:00 vs 14:01:00
  });

  it('is negative when the race runs ahead of the plan', () => {
    expect(driftSecondsAgainst([{ id: 's1', actualStartAt: at('2026-10-24T12:59:15.000Z') }], baseline)).toBe(-45);
  });

  it('is 0 when exactly on plan', () => {
    expect(driftSecondsAgainst([{ id: 's1', actualStartAt: at('2026-10-24T13:00:00.000Z') }], baseline)).toBe(0);
  });

  it('is null without a baseline, without a started stint, or when a started stint is not in the baseline', () => {
    expect(driftSecondsAgainst([{ id: 's1', actualStartAt: at('2026-10-24T13:00:00.000Z') }], null)).toBeNull();
    expect(driftSecondsAgainst([{ id: 's1', actualStartAt: null }], baseline)).toBeNull();
    expect(driftSecondsAgainst([{ id: 'new', actualStartAt: at('2026-10-24T13:00:00.000Z') }], baseline)).toBeNull();
  });

  it('skips a started stint that is not in the baseline and uses the latest one that is', () => {
    const stints = [
      { id: 's1', actualStartAt: at('2026-10-24T13:01:00.000Z') },
      { id: 'inserted-later', actualStartAt: at('2026-10-24T14:00:00.000Z') },
    ];
    expect(driftSecondsAgainst(stints, baseline)).toBe(60);
  });
});

describe('PlanBaselineService', () => {
  function setup(stored: PlanBaseline | null | 'no-team', stintIds: string[] = ['s1', 's2']) {
    const teamsRepository = {
      findOne: vi.fn().mockResolvedValue(stored === 'no-team' ? null : { id: 't1', planBaseline: stored }),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };
    const stintsRepository = { find: vi.fn().mockResolvedValue(stintIds.map((id) => ({ id }))) };
    const planEvents = { emit: vi.fn() };
    const streams = { notifyChanged: vi.fn() };
    const service = new PlanBaselineService(teamsRepository as never, stintsRepository as never, planEvents as never, streams as never);
    return { service, teamsRepository, planEvents, streams };
  }

  const dto = {
    stints: [
      { id: 's1', startsAt: '2026-10-24T13:00:00.000Z', endsAt: '2026-10-24T14:00:00.000Z' },
      { id: 's2', startsAt: '2026-10-24T14:01:00.000Z', endsAt: '2026-10-24T15:01:00.000Z' },
    ],
  };

  it('get returns the stored baseline, null when none, and 404 for a team of another event', async () => {
    await expect(setup(baseline).service.get('e1', 't1')).resolves.toBe(baseline);
    await expect(setup(null).service.get('e1', 't1')).resolves.toBeNull();
    await expect(setup('no-team').service.get('e1', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('set stores the plan (MANUAL unless said otherwise) and tells plan pages and follow pages', async () => {
    const { service, teamsRepository, planEvents, streams } = setup(null);
    const saved = await service.set('e1', 't1', dto, 'u1');
    expect(saved.source).toBe('MANUAL');
    expect(saved.stints).toEqual(dto.stints);
    expect(Number.isNaN(Date.parse(saved.takenAt))).toBe(false);
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { planBaseline: saved });
    expect(planEvents.emit).toHaveBeenCalledWith('e1', 't1', 'team', 'u1');
    expect(streams.notifyChanged).toHaveBeenCalledWith('t1');
    expect((await setup(null).service.set('e1', 't1', { ...dto, source: 'AUTO' })).source).toBe('AUTO');
  });

  it('set refuses a stint that is not one of the team stints, and stores nothing', async () => {
    const { service, teamsRepository } = setup(null, ['s1']);
    await expect(service.set('e1', 't1', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(teamsRepository.update).not.toHaveBeenCalled();
  });

  it('clear removes it and tells the pages', async () => {
    const { service, teamsRepository, planEvents } = setup(baseline);
    await service.clear('e1', 't1', 'u1');
    expect(teamsRepository.update).toHaveBeenCalledWith({ id: 't1', eventId: 'e1' }, { planBaseline: null });
    expect(planEvents.emit).toHaveBeenCalledWith('e1', 't1', 'team', 'u1');
  });
});

describe('PlanBaselineController guards', () => {
  it('needs login on every route, and the team-manage guard to save or clear', () => {
    expect(Reflect.getMetadata('__guards__', PlanBaselineController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata('__guards__', PlanBaselineController.prototype.get)).toBeUndefined();
    for (const method of ['set', 'clear'] as const) {
      expect(Reflect.getMetadata('__guards__', PlanBaselineController.prototype[method])).toEqual([TeamManageGuard]);
      expect(Reflect.getMetadata(TEAM_MANAGE_KEY, PlanBaselineController.prototype[method])).toEqual({ from: 'teamParam' });
    }
  });
});
