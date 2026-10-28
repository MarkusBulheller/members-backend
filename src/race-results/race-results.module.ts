import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarsModule } from '../cars/cars.module.js';
import { DiscordBotModule } from '../discord-bot/discord-bot.module.js';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { EventTeam } from '../events/event-team.entity.js';
import { Event } from '../events/event.entity.js';
import { EventsModule } from '../events/events.module.js';
import { IracingTeam } from '../iracing/iracing-team.entity.js';
import { IracingModule } from '../iracing/iracing.module.js';
import { TracksModule } from '../tracks/tracks.module.js';
import { User } from '../users/user.entity.js';
import { RaceResultDriverStint } from './race-result-driver-stint.entity.js';
import { RaceResultLap } from './race-result-lap.entity.js';
import { RaceResult } from './race-result.entity.js';
import { PublicRaceResultsController } from './public-race-results.controller.js';
import { RaceResultsController } from './race-results.controller.js';
import { RaceResultsService } from './race-results.service.js';
import { RaceSummaryDmService } from './race-summary-dm.service.js';
import { ResultEventLinkService } from './result-event-link.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([RaceResult, RaceResultDriverStint, RaceResultLap, IracingTeam, Event, EventTeam, DriverProfile, User]),
    IracingModule,
    DriversModule,
    CarsModule,
    TracksModule,
    EventsModule,
    DiscordBotModule,
  ],
  controllers: [RaceResultsController, PublicRaceResultsController],
  providers: [RaceResultsService, ResultEventLinkService, RaceSummaryDmService],
  exports: [RaceResultsService],
})
export class RaceResultsModule {}
