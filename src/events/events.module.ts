import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamAccessModule } from '../auth/team-access.module.js';
import { DiscordBotModule } from '../discord-bot/discord-bot.module.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { User } from '../users/user.entity.js';
import { EventGuestSignup } from './event-guest-signup.entity.js';
import { EventGuestSignupsService } from './event-guest-signups.service.js';
import { EventSignup } from './event-signup.entity.js';
import { EventTeamDriverSettingsController } from './event-team-driver-settings.controller.js';
import { EventTeamDriverSettingsService } from './event-team-driver-settings.service.js';
import { EventTeamDriverSettings } from './event-team-driver-settings.entity.js';
import { EventTeamDummyDriversController } from './event-team-dummy-drivers.controller.js';
import { EventTeamDummyDriversService } from './event-team-dummy-drivers.service.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTeamUpcomingStintsService } from './event-team-upcoming-stints.service.js';
import { EventTeamLead } from './event-team-lead.entity.js';
import { EventTeamLeadsController } from './event-team-leads.controller.js';
import { EventTeamStint } from './event-team-stint.entity.js';
import { EventTeamStintsController } from './event-team-stints.controller.js';
import { EventTeamStintsService } from './event-team-stints.service.js';
import { EventTeam } from './event-team.entity.js';
import { EventTeamsController } from './event-teams.controller.js';
import { EventTeamsService } from './event-teams.service.js';
import { EventTimeslot } from './event-timeslot.entity.js';
import { Event } from './event.entity.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { PublicEventsController } from './public-events.controller.js';
import { TeamPlanEventsService } from './team-plan-events.service.js';
import { TeamPlanPresenceService } from './team-plan-presence.service.js';
import { TeamPlanStreamController } from './team-plan-stream.controller.js';
import { FollowLinkController } from './follow/follow-link.controller.js';
import { FollowLinkService } from './follow/follow-link.service.js';
import { FollowStateService } from './follow/follow-state.service.js';
import { FollowStreamService } from './follow/follow-stream.service.js';
import { PublicFollowController } from './follow/public-follow.controller.js';
import { Car } from '../cars/car.entity.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { IracingModule } from '../iracing/iracing.module.js';
import { IracingTeamMember } from '../iracing/iracing-team-member.entity.js';
import { ReadinessController } from './readiness/readiness.controller.js';
import { ReadinessService } from './readiness/readiness.service.js';
import { EventTeamThreadController } from './event-team-thread.controller.js';
import { EventTeamThreadService } from './event-team-thread.service.js';
import { EventChannelController } from './event-channel.controller.js';
import { EventChannelService } from './event-channel.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      EventSignup,
      EventGuestSignup,
      EventTimeslot,
      EventTeam,
      EventTeamLead,
      EventTeamStint,
      EventTeamDriverSettings,
      EventTeamDummyDriver,
      User,
      DriverProfile,
      Car,
      IracingTeamMember,
      RaceResult,
    ]),
    DiscordBotModule,
    TeamAccessModule,
    IracingModule,
  ],
  controllers: [
    EventsController,
    EventTeamsController,
    EventTeamLeadsController,
    EventTeamStintsController,
    EventTeamDriverSettingsController,
    EventTeamDummyDriversController,
    PublicEventsController,
    TeamPlanStreamController,
    FollowLinkController,
    PublicFollowController,
    ReadinessController,
    EventTeamThreadController,
    EventChannelController,
  ],
  providers: [
    EventsService,
    EventGuestSignupsService,
    EventTeamsService,
    EventTeamStintsService,
    EventTeamDriverSettingsService,
    EventTeamDummyDriversService,
    EventTeamUpcomingStintsService,
    TeamPlanEventsService,
    TeamPlanPresenceService,
    FollowLinkService,
    FollowStateService,
    FollowStreamService,
    ReadinessService,
    EventTeamThreadService,
    EventChannelService,
  ],
  exports: [TeamPlanEventsService, EventsService, EventGuestSignupsService],
})
export class EventsModule {}
