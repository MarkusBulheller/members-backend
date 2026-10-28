import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordBotModule } from '../discord-bot/discord-bot.module.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { RaceResultsModule } from '../race-results/race-results.module.js';
import { IracingAutoImportController } from './iracing-auto-import.controller.js';
import { IracingAutoImportSettings } from './iracing-auto-import-settings.entity.js';
import { IracingAutoImportSettingsService } from './iracing-auto-import-settings.service.js';
import { IracingResultAttempt } from './iracing-result-attempt.entity.js';
import { IracingResultAutoImportService } from './iracing-result-auto-import.service.js';
import { IracingTeam } from './iracing-team.entity.js';
import { IracingModule } from './iracing.module.js';

/** Automatic race-result import. A module of its own (rather than part of IracingModule) because it
 * needs RaceResultsService and the Discord bot, and RaceResultsModule/DiscordBotModule already
 * depend on IracingModule — putting it there would be a circular import. */
@Module({
  imports: [
    TypeOrmModule.forFeature([IracingAutoImportSettings, IracingResultAttempt, IracingTeam, RaceResult]),
    IracingModule,
    RaceResultsModule,
    DiscordBotModule,
  ],
  controllers: [IracingAutoImportController],
  providers: [IracingAutoImportSettingsService, IracingResultAutoImportService],
})
export class IracingAutoImportModule {}
