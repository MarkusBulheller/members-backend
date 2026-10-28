import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventSignup } from '../events/event-signup.entity.js';
import { EventTeamLead } from '../events/event-team-lead.entity.js';
import { EventTeam } from '../events/event-team.entity.js';
import { User } from '../users/user.entity.js';
import { TeamLeadsService } from './team-leads.service.js';
import { TeamManageGuard } from './team-manage.guard.js';
import { TeamManagePolicy } from './team-manage.policy.js';

/** Team-lead permissions: the policy/guard behind `@TeamManage()` and the lead management
 * service. Import this into any module whose controllers use `@TeamManage()` (the guard is
 * instantiated in the importing module's injector) or that reads/writes leads. */
@Module({
  imports: [TypeOrmModule.forFeature([EventTeamLead, EventTeam, EventSignup, User])],
  providers: [TeamManagePolicy, TeamManageGuard, TeamLeadsService],
  exports: [TeamManagePolicy, TeamManageGuard, TeamLeadsService],
})
export class TeamAccessModule {}
