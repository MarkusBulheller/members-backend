import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { DiscordService } from './discord.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly discordService: DiscordService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  private get frontendUrl(): string {
    return this.configService.getOrThrow<string>('FRONTEND_URL');
  }

  @Get('discord')
  beginDiscordLogin(@Res() res: Response) {
    const state = this.authService.generateOAuthState();
    res.cookie(this.authService.oauthStateCookieName, state, this.authService.oauthStateCookieOptions());
    res.redirect(this.discordService.buildAuthorizeUrl(state));
  }

  @Get('discord/callback')
  async handleDiscordCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const expectedState = req.cookies?.[this.authService.oauthStateCookieName] as string | undefined;
    res.clearCookie(this.authService.oauthStateCookieName, this.authService.oauthStateCookieOptions());

    if (!code || !state || !expectedState || state !== expectedState) {
      return res.redirect(`${this.frontendUrl}/login?error=oauth_failed`);
    }

    let identity: Awaited<ReturnType<DiscordService['completeOAuthFlow']>>;
    try {
      identity = await this.discordService.completeOAuthFlow(code);
    } catch {
      return res.redirect(`${this.frontendUrl}/login?error=oauth_failed`);
    }

    if (!identity) {
      return res.redirect(`${this.frontendUrl}/not-in-server`);
    }

    const user = await this.usersService.upsertFromDiscord(identity);

    if (user.status !== UserStatus.APPROVED) {
      return res.redirect(`${this.frontendUrl}/pending-approval?status=${user.status}`);
    }

    const token = this.authService.signSessionToken(user);
    res.cookie(this.authService.sessionCookieName, token, this.authService.sessionCookieOptions());
    return res.redirect(`${this.frontendUrl}/dashboard`);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(this.authService.sessionCookieName, this.authService.sessionCookieOptions());
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    const { tokenVersion: _tokenVersion, ...safeUser } = user;
    return safeUser;
  }
}
