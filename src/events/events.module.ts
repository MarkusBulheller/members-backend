import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordBotModule } from '../discord-bot/discord-bot.module.js';
import { EventSignup } from './event-signup.entity.js';
import { EventTeamDriverSettingsController } from './event-team-driver-settings.controller.js';
import { EventTeamDriverSettingsService } from './event-team-driver-settings.service.js';
import { EventTeamDriverSettings } from './event-team-driver-settings.entity.js';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, EventSignup, EventTimeslot, EventTeam, EventTeamStint, EventTeamDriverSettings]),
    DiscordBotModule,
  ],
  controllers: [
    EventsController,
    EventTeamsController,
    EventTeamStintsController,
    EventTeamDriverSettingsController,
    PublicEventsController,
  ],
  providers: [EventsService, EventTeamsService, EventTeamStintsService, EventTeamDriverSettingsService],
})
export class EventsModule {}
