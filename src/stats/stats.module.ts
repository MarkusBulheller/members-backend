import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RaceResult } from '../race-results/race-result.entity.js';
import { PublicStatsController } from './public-stats.controller.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RaceResult])],
  controllers: [StatsController, PublicStatsController],
  providers: [StatsService],
})
export class StatsModule {}
