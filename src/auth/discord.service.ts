import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface VerifiedDiscordIdentity {
  discordId: string;
  discordUsername: string;
  discordGlobalName: string | null;
  discordAvatarUrl: string | null;
}

@Injectable()
export class DiscordService {
  private readonly logger = new Logger(DiscordService.name);

  constructor(private readonly configService: ConfigService) {}

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.configService.getOrThrow<string>('DISCORD_CLIENT_ID'),
      redirect_uri: this.configService.getOrThrow<string>('DISCORD_REDIRECT_URI'),
      response_type: 'code',
      scope: 'identify guilds.members.read',
      state,
      prompt: 'consent',
    });

    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  }

  private async exchangeCodeForToken(code: string): Promise<DiscordTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.configService.getOrThrow<string>('DISCORD_CLIENT_ID'),
      client_secret: this.configService.getOrThrow<string>('DISCORD_CLIENT_SECRET'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.configService.getOrThrow<string>('DISCORD_REDIRECT_URI'),
    });

    const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`Discord token exchange failed: ${response.status} ${text}`);
      throw new Error('Discord token exchange failed');
    }

    return response.json() as Promise<DiscordTokenResponse>;
  }

  private async fetchUser(accessToken: string): Promise<DiscordUserResponse> {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch Discord user identity');
    }

    return response.json() as Promise<DiscordUserResponse>;
  }

  /** Returns true if the authenticated user is a member of the configured guild.
   * Uses the user's own OAuth token (guilds.members.read scope) — no bot required. */
  private async isGuildMember(accessToken: string): Promise<boolean> {
    const guildId = this.configService.getOrThrow<string>('DISCORD_GUILD_ID');

    const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`Discord guild-membership check failed: ${response.status} ${text}`);
      throw new Error('Discord guild-membership check failed');
    }

    return true;
  }

  private buildAvatarUrl(user: DiscordUserResponse): string | null {
    if (!user.avatar) {
      return null;
    }
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
  }

  /** Full handshake: exchange the code, fetch identity, and enforce guild membership.
   * Returns null if the user is authenticated with Discord but is not in the team's guild. */
  async completeOAuthFlow(code: string): Promise<VerifiedDiscordIdentity | null> {
    const token = await this.exchangeCodeForToken(code);

    const inGuild = await this.isGuildMember(token.access_token);
    if (!inGuild) {
      return null;
    }

    const user = await this.fetchUser(token.access_token);

    return {
      discordId: user.id,
      discordUsername: user.username,
      discordGlobalName: user.global_name,
      discordAvatarUrl: this.buildAvatarUrl(user),
    };
  }
}
