import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { ListResultAttemptsQueryDto } from './dto/list-result-attempts-query.dto.js';
import { UpdateAutoImportSettingsDto } from './dto/update-auto-import-settings.dto.js';
import { IracingAutoImportController } from './iracing-auto-import.controller.js';
import { IracingAutoImportSettingsService } from './iracing-auto-import-settings.service.js';
import { IracingController } from './iracing.controller.js';

const reflector = new Reflector();

function rolesGuardAllows(handler: (...args: never[]) => unknown, role: Role): boolean {
  const guard = new RolesGuard(reflector);
  const context = {
    getHandler: () => handler,
    getClass: () => IracingAutoImportController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  };
  try {
    return guard.canActivate(context as never);
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}

describe('IracingAutoImportController guards', () => {
  it('is behind the JWT guard and the roles guard at class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, IracingAutoImportController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it.each([
    ['getSettings', IracingAutoImportController.prototype.getSettings],
    ['updateSettings', IracingAutoImportController.prototype.updateSettings],
    ['listAttempts', IracingAutoImportController.prototype.listAttempts],
    ['importAttempt', IracingAutoImportController.prototype.importAttempt],
    ['ignoreAttempt', IracingAutoImportController.prototype.ignoreAttempt],
    ['run', IracingAutoImportController.prototype.run],
  ])('%s is admin-only', (_name, handler) => {
    expect(rolesGuardAllows(handler as never, Role.ADMIN)).toBe(true);
    expect(rolesGuardAllows(handler as never, Role.MEMBER)).toBe(false);
  });

  it('PATCH /iracing/teams/:teamId is admin-only', () => {
    const guard = new RolesGuard(reflector);
    const context = (role: Role) => ({
      getHandler: () => IracingController.prototype.updateTeam,
      getClass: () => IracingController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    });
    expect(guard.canActivate(context(Role.ADMIN) as never)).toBe(true);
    expect(() => guard.canActivate(context(Role.MEMBER) as never)).toThrow(ForbiddenException);
  });

  it('delegates to the services', async () => {
    const settings = { getView: vi.fn().mockResolvedValue({ enabled: false }), update: vi.fn().mockResolvedValue({ enabled: true }) };
    const service = {
      listAttempts: vi.fn().mockResolvedValue([]),
      importNow: vi.fn().mockResolvedValue({}),
      ignore: vi.fn().mockResolvedValue({}),
      run: vi.fn().mockResolvedValue({}),
    };
    const controller = new IracingAutoImportController(settings as never, service as never);
    await controller.getSettings();
    await controller.updateSettings({ enabled: true });
    await controller.listAttempts({ status: 'FOUND', limit: 5 });
    await controller.importAttempt('id-1', { id: 'admin-1' } as never);
    await controller.ignoreAttempt('id-1');
    await controller.run();
    expect(settings.update).toHaveBeenCalledWith({ enabled: true });
    expect(service.listAttempts).toHaveBeenCalledWith('FOUND', 5);
    expect(service.importNow).toHaveBeenCalledWith('id-1', 'admin-1');
    expect(service.ignore).toHaveBeenCalledWith('id-1');
    expect(service.run).toHaveBeenCalled();
  });
});

describe('UpdateAutoImportSettingsDto', () => {
  const check = async (body: Record<string, unknown>) => validate(plainToInstance(UpdateAutoImportSettingsDto, body));

  it('accepts valid bodies', async () => {
    expect(await check({})).toHaveLength(0);
    expect(await check({ enabled: true, mode: 'AUTO', delayMinutes: 5 })).toHaveLength(0);
    expect(await check({ delayMinutes: 240 })).toHaveLength(0);
  });

  it('rejects out-of-range delays, unknown modes and non-boolean flags', async () => {
    expect(await check({ delayMinutes: 4 })).not.toHaveLength(0);
    expect(await check({ delayMinutes: 241 })).not.toHaveLength(0);
    expect(await check({ delayMinutes: 20.5 })).not.toHaveLength(0);
    expect(await check({ mode: 'MANUAL' })).not.toHaveLength(0);
    expect(await check({ enabled: 'yes' })).not.toHaveLength(0);
  });
});

describe('ListResultAttemptsQueryDto', () => {
  const check = async (query: Record<string, unknown>) => validate(plainToInstance(ListResultAttemptsQueryDto, query));

  it('accepts a status and a numeric-string limit', async () => {
    const dto = plainToInstance(ListResultAttemptsQueryDto, { status: 'IGNORED', limit: '25' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.limit).toBe(25);
    expect(await check({})).toHaveLength(0);
  });

  it('rejects an unknown status and a bad limit', async () => {
    expect(await check({ status: 'DONE' })).not.toHaveLength(0);
    expect(await check({ limit: '0' })).not.toHaveLength(0);
    expect(await check({ limit: '1000' })).not.toHaveLength(0);
  });
});

describe('IracingAutoImportSettingsService', () => {
  function make(row: Record<string, unknown>) {
    const repository = {
      findOne: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(undefined),
      save: vi.fn(),
      create: vi.fn(),
    };
    const discord = { getSettings: vi.fn().mockResolvedValue({ resultsChannelId: '123456789012345678' }) };
    return { service: new IracingAutoImportSettingsService(repository as never, discord as never), repository };
  }
  const base = { id: 1, enabled: false, mode: 'NOTIFY', delayMinutes: 20, enabledSince: null, lastRunAt: null, lastRunStatus: null, lastRunMessage: null };

  it('stamps enabledSince only on a false to true switch', async () => {
    const now = new Date('2026-10-24T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const off = make(base);
    await off.service.update({ enabled: true });
    expect(off.repository.update).toHaveBeenCalledWith(1, { enabled: true, enabledSince: now });

    const on = make({ ...base, enabled: true, enabledSince: new Date('2026-10-01T00:00:00Z') });
    await on.service.update({ enabled: true, mode: 'AUTO', delayMinutes: 30 });
    expect(on.repository.update).toHaveBeenCalledWith(1, { enabled: true, mode: 'AUTO', delayMinutes: 30 });

    const turnOff = make({ ...base, enabled: true });
    await turnOff.service.update({ enabled: false });
    expect(turnOff.repository.update).toHaveBeenCalledWith(1, { enabled: false });
    vi.useRealTimers();
  });

  it('returns the contract shape including the results channel from the Discord settings', async () => {
    const { service } = make(base);
    const view = await service.getView();
    expect(Object.keys(view).sort()).toEqual(
      ['delayMinutes', 'enabled', 'enabledSince', 'lastRunAt', 'lastRunMessage', 'lastRunStatus', 'mode', 'resultsChannelId'].sort(),
    );
    expect(view.resultsChannelId).toBe('123456789012345678');
  });
});
