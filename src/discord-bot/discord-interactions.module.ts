import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriversModule } from '../drivers/drivers.module.js';
import { EventSignup } from '../events/event-signup.entity.js';
import { Event } from '../events/event.entity.js';
import { EventsModule } from '../events/events.module.js';
import { User } from '../users/user.entity.js';
import { DiscordBotModule } from './discord-bot.module.js';
import { DiscordInteractionsController } from './discord-interactions.controller.js';
import { DiscordInteractionsService } from './discord-interactions.service.js';

/** Separate from DiscordBotModule on purpose: EventsModule imports DiscordBotModule (to post
 * announcements), while the interaction flow needs EventsModule's signup services — one module
 * for both directions would be circular. */
@Module({
  imports: [TypeOrmModule.forFeature([Event, EventSignup, User]), DiscordBotModule, EventsModule, DriversModule],
  controllers: [DiscordInteractionsController],
  providers: [DiscordInteractionsService],
})
export class DiscordInteractionsModule {}
