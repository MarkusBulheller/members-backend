import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicTeamHighlightsController } from './public-team-highlights.controller.js';
import { TeamHighlight } from './team-highlight.entity.js';
import { TeamHighlightsController } from './team-highlights.controller.js';
import { TeamHighlightsService } from './team-highlights.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([TeamHighlight])],
  controllers: [TeamHighlightsController, PublicTeamHighlightsController],
  providers: [TeamHighlightsService],
})
export class TeamHighlightsModule {}
