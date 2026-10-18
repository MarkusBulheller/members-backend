import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarTrackSetup } from './car-track-setup.entity.js';
import { CarTrackSetupsController } from './car-track-setups.controller.js';
import { CarTrackSetupsService } from './car-track-setups.service.js';
import { TrackCarSetupsController } from './track-car-setups.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([CarTrackSetup])],
  controllers: [CarTrackSetupsController, TrackCarSetupsController],
  providers: [CarTrackSetupsService],
})
export class CarTrackSetupsModule {}
