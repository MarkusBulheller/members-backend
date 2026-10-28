import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type TeamManageOptions, type TeamManageRequest, TeamManagePolicy } from './team-manage.policy.js';

export const TEAM_MANAGE_KEY = 'teamManage';

/** Authorises a request for ADMINs and for the lead of the iRacing team of the event team the
 * request addresses (see TeamManagePolicy). Runs after JwtAuthGuard (class-level) so `req.user`
 * is set. Deny by default: a handler that uses the guard without `@TeamManage()` is refused. */
@Injectable()
export class TeamManageGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: TeamManagePolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<TeamManageOptions | undefined>(TEAM_MANAGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) throw new ForbiddenException('Insufficient permissions');
    const request = context.switchToHttp().getRequest<TeamManageRequest>();
    await this.policy.assertCanManage(request, options);
    return true;
  }
}

/** Replaces `@UseGuards(RolesGuard) @Roles(Role.ADMIN)` on the few endpoints a team lead may use.
 * `from` says where the event team comes from (default the `:teamId` URL param); `restrict` adds
 * the field-level limits a non-admin is held to (see TeamManageRestrict). */
export const TeamManage = (options: TeamManageOptions = {}) =>
  applyDecorators(SetMetadata(TEAM_MANAGE_KEY, { from: 'teamParam', ...options }), UseGuards(TeamManageGuard));
