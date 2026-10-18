import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverProfile } from '../drivers/driver-profile.entity.js';
import { RaceResult } from '../race-results/race-result.entity.js';
import { User } from '../users/user.entity.js';
import { Car } from './car.entity.js';
import { CarsController } from './cars.controller.js';
import { CarsService } from './cars.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Car, RaceResult, DriverProfile, User])],
  controllers: [CarsController],
  providers: [CarsService],
  exports: [CarsService],
})
export class CarsModule {}
