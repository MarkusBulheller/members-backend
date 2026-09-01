import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResultDriverStint } from '../race-results/race-result-driver-stint.entity.js';
import { AchievementAward } from './achievement-award.entity.js';
import { AchievementDefinition } from './achievement-definition.entity.js';
import { AchievementTier } from './achievement-tier.entity.js';
import { AchievementsController } from './achievements.controller.js';
import { AchievementsService } from './achievements.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AchievementDefinition, AchievementTier, AchievementAward, DriverProfile, RaceResultDriverStint]),
  ],
  controllers: [AchievementsController],
  providers: [AchievementsService],
})
export class AchievementsModule {}
