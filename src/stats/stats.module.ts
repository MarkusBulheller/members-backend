import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IracingTeam } from '../iracing/iracing-team.entity.js';
import { RaceResultDriverStint } from '../race-results/race-result-driver-stint.entity.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { PublicStatsController } from './public-stats.controller.js';
import { RecapService } from './recap.service.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RaceResult, RaceResultDriverStint, IracingTeam])],
  controllers: [StatsController, PublicStatsController],
  providers: [StatsService, RecapService],
})
export class StatsModule {}
