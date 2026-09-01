import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarsModule } from '../cars/cars.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { IracingModule } from '../iracing/iracing.module.js';
import { TracksModule } from '../tracks/tracks.module.js';
import { RaceResultDriverStint } from './race-result-driver-stint.entity.js';
import { RaceResultLap } from './race-result-lap.entity.js';
import { RaceResult } from './race-result.entity.js';
import { PublicRaceResultsController } from './public-race-results.controller.js';
import { RaceResultsController } from './race-results.controller.js';
import { RaceResultsService } from './race-results.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([RaceResult, RaceResultDriverStint, RaceResultLap]),
    IracingModule,
    DriversModule,
    CarsModule,
    TracksModule,
  ],
  controllers: [RaceResultsController, PublicRaceResultsController],
  providers: [RaceResultsService],
})
export class RaceResultsModule {}
