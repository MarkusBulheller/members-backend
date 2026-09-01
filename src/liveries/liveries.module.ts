import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiveriesController } from './liveries.controller.js';
import { LiveriesService } from './liveries.service.js';
import { Livery } from './livery.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Livery])],
  controllers: [LiveriesController],
  providers: [LiveriesService],
})
export class LiveriesModule {}
