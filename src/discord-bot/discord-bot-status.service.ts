import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Discord permission bitfields exceed 32 bits (well past SEND_MESSAGES/VIEW_CHANNEL themselves,
// but the full permission strings returned alongside them routinely do) — JS's native `&`/`|`
// coerce to 32-bit signed integers and would silently corrupt anything built from those values,
// so every permission computed here stays a BigInt end to end.
const PERMISSION = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  ADMINISTRATOR: 1n << 3n,
} as const;

const REQUIRED_PERMISSIONS: { bit: bigint; label: string }[] = [
  { bit: PERMISSION.VIEW_CHANNEL, label: 'View Channel' },
  { bit: PERMISSION.SEND_MESSAGES, label: 'Send Messages' },
];

export interface DiscordBotStatus {
  tokenValid: boolean;
  botUsername: string | null;
  guildConfigured: boolean;
  inGuild: boolean | null;
  channelConfigured: boolean;
  channelPermissionsOk: boolean | null;
  missingPermissions: string[];
  error: string | null;
}

interface DiscordOverwrite {
  id: string;
  type: number; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

/** Live-checks the configured bot against Discord's own API — not just "is a token saved" but
 * "would postEventAnnouncement actually work right now": is the token valid, is the bot actually
 * in the team's guild, and does it hold View Channel + Send Messages in the configured
 * announcements channel once every role and channel-specific override is accounted for. Every
 * external call is wrapped so a Discord outage or a bad token surfaces as a normal status field,
 * never an unhandled rejection — this is a diagnostic page, not something that should ever crash
 * on a misconfigured bot. */
@Injectable()
export class DiscordBotStatusService {
  private readonly logger = new Logger(DiscordBotStatusService.name);

  constructor(
    private readonly discordBotSettingsService: DiscordBotSettingsService,
    private readonly configService: ConfigService,
  ) {}

  async checkStatus(): Promise<DiscordBotStatus> {
    const { token, channelId } = await this.discordBotSettingsService.getCredentialsForPosting();
    const guildId = this.configService.get<string>('DISCORD_GUILD_ID') ?? null;

    const status: DiscordBotStatus = {
      tokenValid: false,
      botUsername: null,
      guildConfigured: Boolean(guildId),
      inGuild: null,
      channelConfigured: Boolean(channelId),
      channelPermissionsOk: null,
      missingPermissions: [],
      error: null,
    };

    if (!token) {
      status.error = 'No bot token configured.';
      return status;
    }

    const me = await this.fetchJson('/users/@me', token);
    if (!me || typeof me.id !== 'string') {
      status.error = 'Bot token was rejected by Discord — it may be revoked or mistyped.';
      return status;
    }
    status.tokenValid = true;
    status.botUsername = typeof me.username === 'string' ? me.username : null;
    const botUserId = me.id;

    if (!guildId) {
      status.error = 'DISCORD_GUILD_ID is not configured on the server — can\'t check guild membership.';
      return status;
    }

    const member = await this.fetchJson(`/guilds/${guildId}/members/${botUserId}`, token);
    if (!member || !Array.isArray(member.roles)) {
      status.inGuild = false;
      return status;
    }
    status.inGuild = true;
    const botRoleIds: string[] = member.roles;

    if (!channelId) {
      return status;
    }

    try {
      const permissions = await this.computeChannelPermissions(token, guildId, channelId, botUserId, botRoleIds);
      if (permissions === null) {
        status.error = 'Could not read the configured channel or its permissions — check the channel ID.';
        return status;
      }
      const missing = REQUIRED_PERMISSIONS.filter((p) => (permissions & p.bit) !== p.bit);
      status.channelPermissionsOk = missing.length === 0;
      status.missingPermissions = missing.map((p) => p.label);
    } catch (err) {
      this.logger.warn('Failed computing Discord channel permissions', err instanceof Error ? err.stack : String(err));
      status.error = 'Failed checking channel permissions — see server logs.';
    }

    return status;
  }

  /** Discord's own documented order: role permissions (the "everyone" role unioned with the
   * bot's other roles) form the base, then the channel's "everyone" overwrite applies, then the
   * union of the bot's own role-specific overwrites, then a member-specific overwrite for the
   * bot itself last. An ADMINISTRATOR bit anywhere in the base short-circuits all of that —
   * overwrites never apply. Returns null if the channel or guild roles couldn't be read at all. */
  private async computeChannelPermissions(
    token: string,
    guildId: string,
    channelId: string,
    botUserId: string,
    botRoleIds: string[],
  ): Promise<bigint | null> {
    const [channel, roles] = await Promise.all([
      this.fetchJson(`/channels/${channelId}`, token),
      this.fetchJson(`/guilds/${guildId}/roles`, token),
    ]);
    if (!channel || !Array.isArray(roles)) return null;

    const everyoneRole = roles.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === guildId) as
      | Record<string, unknown>
      | undefined;
    let base = everyoneRole && typeof everyoneRole.permissions === 'string' ? BigInt(everyoneRole.permissions) : 0n;
    for (const roleId of botRoleIds) {
      const role = roles.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === roleId) as
        | Record<string, unknown>
        | undefined;
      if (role && typeof role.permissions === 'string') base |= BigInt(role.permissions);
    }

    if ((base & PERMISSION.ADMINISTRATOR) === PERMISSION.ADMINISTRATOR) {
      return base;
    }

    const overwrites: DiscordOverwrite[] = Array.isArray(channel.permission_overwrites)
      ? (channel.permission_overwrites as DiscordOverwrite[])
      : [];

    const everyoneOverwrite = overwrites.find((o) => o.id === guildId && o.type === 0);
    if (everyoneOverwrite) {
      base &= ~BigInt(everyoneOverwrite.deny);
      base |= BigInt(everyoneOverwrite.allow);
    }

    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const roleId of botRoleIds) {
      const overwrite = overwrites.find((o) => o.id === roleId && o.type === 0);
      if (overwrite) {
        roleAllow |= BigInt(overwrite.allow);
        roleDeny |= BigInt(overwrite.deny);
      }
    }
    base &= ~roleDeny;
    base |= roleAllow;

    const memberOverwrite = overwrites.find((o) => o.id === botUserId && o.type === 1);
    if (memberOverwrite) {
      base &= ~BigInt(memberOverwrite.deny);
      base |= BigInt(memberOverwrite.allow);
    }

    return base;
  }

  /** Returns null (never throws) on any non-2xx or network failure — every caller above treats
   * null as "couldn't determine this," which is what a diagnostic page should degrade to. */
  private async fetchJson(path: string, token: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${DISCORD_API_BASE}${path}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`Discord API request failed: ${path}`, err instanceof Error ? err.stack : String(err));
      return null;
    }
  }
}
