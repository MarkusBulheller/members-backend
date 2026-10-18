import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions } from 'express';
import { randomBytes } from 'node:crypto';
import { User } from '../users/user.entity.js';
import { parseDurationToMs } from './duration.util.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  get sessionCookieName(): string {
    return this.configService.get<string>('COOKIE_NAME', 'w2w_session');
  }

  get oauthStateCookieName(): string {
    return `${this.sessionCookieName}_oauth_state`;
  }

  /** Optional public Discord invite link (DISCORD_INVITE_URL), shown to people waiting for
   * approval so they can ask an admin. Only http(s) URLs are accepted; null when unset/invalid. */
  get discordInviteUrl(): string | null {
    const raw = this.configService.get<string>('DISCORD_INVITE_URL')?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  }

  generateOAuthState(): string {
    return randomBytes(24).toString('hex');
  }

  signSessionToken(user: User): string {
    return this.jwtService.sign({ sub: user.id, tokenVersion: user.tokenVersion });
  }

  private get isProduction(): boolean {
    return this.configService.get<string>('NODE_ENV') === 'production';
  }

  sessionCookieOptions(): CookieOptions {
    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '7d');
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: parseDurationToMs(expiresIn),
      path: '/',
    };
  }

  oauthStateCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: 5 * 60 * 1000,
      path: '/',
    };
  }
}
