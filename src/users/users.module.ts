import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriversModule } from '../drivers/drivers.module.js';
import { AdminMembersController } from './admin-members.controller.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([User]), DriversModule],
  controllers: [AdminMembersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
