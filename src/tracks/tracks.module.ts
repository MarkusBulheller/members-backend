import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Track } from './track.entity.js';
import { TracksController } from './tracks.controller.js';
import { TracksService } from './tracks.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Track])],
  controllers: [TracksController],
  providers: [TracksService],
  exports: [TracksService],
})
export class TracksModule {}
