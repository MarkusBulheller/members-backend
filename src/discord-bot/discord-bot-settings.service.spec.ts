import { describe, expect, it, vi } from 'vitest';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';

function makeService(row: Record<string, unknown>) {
  const queryBuilder = {
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    getOne: vi.fn().mockResolvedValue(row),
  };
  const repository = {
    findOne: vi.fn().mockResolvedValue({ id: 'singleton' }),
    createQueryBuilder: vi.fn().mockReturnValue(queryBuilder),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const service = new DiscordBotSettingsService(repository as never, { get: vi.fn() } as never);
  return { service, repository };
}

describe('DiscordBotSettingsService interactions settings', () => {
  const KEY = 'ab'.repeat(32);

  it('reports only whether a public key is set, never the key or the token', async () => {
    const { service } = makeService({ botToken: 'secret', publicKey: KEY, eventsChannelId: '1', alertUserId: '2', resultsChannelId: '3', eventCategoryId: '4' });
    const view = await service.getSettings();
    expect(view).toEqual({
      hasToken: true,
      eventsChannelId: '1',
      resultsChannelId: '3',
      eventCategoryId: '4',
      publicKeySet: true,
      alertUserId: '2',
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it('stores, clears and reads back the event category', async () => {
    const { service, repository } = makeService({ botToken: 'secret', eventsChannelId: null, alertUserId: null });
    await service.update({ eventCategoryId: '135558244635516998' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { eventCategoryId: '135558244635516998' });
    await service.update({ eventCategoryId: '' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { eventCategoryId: null });
    expect(await service.getEventChannelCredentials()).toEqual({ token: 'secret', categoryId: null });
  });

  it('stores a new public key lowercased, leaves it alone when blank, and clears the alert user on empty string', async () => {
    const { service, repository } = makeService({ botToken: null, publicKey: KEY, eventsChannelId: null, alertUserId: null });

    await service.update({ publicKey: KEY.toUpperCase(), alertUserId: '123456789012345678' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { publicKey: KEY, alertUserId: '123456789012345678' });

    repository.update.mockClear();
    await service.update({ publicKey: '' });
    expect(repository.update).not.toHaveBeenCalled();

    await service.update({ alertUserId: '' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { alertUserId: null });
  });

  it('stores, reports and clears the results channel; exposes it with the token for posting', async () => {
    const { service, repository } = makeService({ botToken: 'secret', resultsChannelId: '999' });
    await service.update({ resultsChannelId: '123456789012345678' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { resultsChannelId: '123456789012345678' });
    await service.update({ resultsChannelId: '' });
    expect(repository.update).toHaveBeenLastCalledWith('singleton', { resultsChannelId: null });
    expect(await service.getResultsPostingCredentials()).toEqual({ token: 'secret', channelId: '999' });
  });

  it('exposes the stored key to the interactions endpoint', async () => {
    const { service } = makeService({ publicKey: KEY, alertUserId: '2' });
    expect(await service.getInteractionConfig()).toEqual({ publicKey: KEY, alertUserId: '2' });
  });
});
