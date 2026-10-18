import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';

function makeService(env: Record<string, string | undefined>) {
  const configService = { get: (key: string, fallback?: string) => env[key] ?? fallback };
  return new AuthService({} as never, configService as never);
}

describe('AuthService.discordInviteUrl', () => {
  it('is null when DISCORD_INVITE_URL is unset or blank', () => {
    expect(makeService({}).discordInviteUrl).toBeNull();
    expect(makeService({ DISCORD_INVITE_URL: '   ' }).discordInviteUrl).toBeNull();
  });

  it('returns a valid https invite link', () => {
    expect(makeService({ DISCORD_INVITE_URL: ' https://discord.gg/abc123 ' }).discordInviteUrl).toBe(
      'https://discord.gg/abc123',
    );
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(makeService({ DISCORD_INVITE_URL: 'javascript:alert(1)' }).discordInviteUrl).toBeNull();
    expect(makeService({ DISCORD_INVITE_URL: 'not a url' }).discordInviteUrl).toBeNull();
  });
});
