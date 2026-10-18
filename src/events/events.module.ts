import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordBotModule } from '../discord-bot/discord-bot.module.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { User } from '../users/user.entity.js';
import { EventSignup } from './event-signup.entity.js';
import { EventTeamDriverSettingsController } from './event-team-driver-settings.controller.js';
import { EventTeamDriverSettingsService } from './event-team-driver-settings.service.js';
import { EventTeamDriverSettings } from './event-team-driver-settings.entity.js';
import { EventTeamDummyDriversController } from './event-team-dummy-drivers.controller.js';
import { EventTeamDummyDriversService } from './event-team-dummy-drivers.service.js';
import { EventTeamDummyDriver } from './event-team-dummy-driver.entity.js';
import { EventTeamUpcomingStintsService } from './event-team-upcoming-stints.service.js';
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
import { TeamPlanStreamController } from './team-plan-stream.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      EventSignup,
      EventTimeslot,
      EventTeam,
      EventTeamStint,
      EventTeamDriverSettings,
      EventTeamDummyDriver,
      User,
      DriverProfile,
    ]),
    DiscordBotModule,
  ],
  controllers: [
    EventsController,
    EventTeamsController,
    EventTeamStintsController,
    EventTeamDriverSettingsController,
    EventTeamDummyDriversController,
    PublicEventsController,
    TeamPlanStreamController,
  ],
  providers: [
    EventsService,
    EventTeamsService,
    EventTeamStintsService,
    EventTeamDriverSettingsService,
    EventTeamDummyDriversService,
    EventTeamUpcomingStintsService,
    TeamPlanEventsService,
  ],
  exports: [TeamPlanEventsService],
})
export class EventsModule {}
