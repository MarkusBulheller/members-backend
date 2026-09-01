import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-jwt';
import { UserStatus } from '../../common/enums/user-status.enum.js';
import { UsersService } from '../../users/users.service.js';

export interface JwtPayload {
  sub: string;
  tokenVersion: number;
}

function cookieExtractor(cookieName: string) {
  return (req: Request): string | null => {
    return (req.cookies?.[cookieName] as string | undefined) ?? null;
  };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: cookieExtractor(configService.get<string>('COOKIE_NAME', 'w2w_session')),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.findById(payload.sub);

    if (!user || user.status !== UserStatus.APPROVED) {
      throw new UnauthorizedException('Account is not active');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return user;
  }
}
