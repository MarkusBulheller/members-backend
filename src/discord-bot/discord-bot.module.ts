import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IracingModule } from '../iracing/iracing.module.js';
import { DiscordBotSettingsController } from './discord-bot-settings.controller.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';
import { DiscordBotSettings } from './discord-bot-settings.entity.js';
import { DiscordBotStatusService } from './discord-bot-status.service.js';
import { DiscordBotService } from './discord-bot.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([DiscordBotSettings]), IracingModule],
  controllers: [DiscordBotSettingsController],
  providers: [DiscordBotService, DiscordBotSettingsService, DiscordBotStatusService],
  exports: [DiscordBotService],
})
export class DiscordBotModule {}
