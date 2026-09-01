import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { DriversService } from '../drivers/drivers.service.js';
import { RejectMemberDto } from './dto/reject-member.dto.js';
import { UpdateRoleDto } from './dto/update-role.dto.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';

@Controller('admin/members')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminMembersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly driversService: DriversService,
  ) {}

  @Get()
  list(@Query('status') status?: string) {
    if (status && !Object.values(UserStatus).includes(status as UserStatus)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    return this.usersService.list(status as UserStatus | undefined);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.usersService.findByIdOrThrow(id);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @CurrentUser() admin: User) {
    const user = await this.usersService.approve(id, admin.id);
    await this.driversService.createProfileForUser(user.id, user.discordGlobalName ?? user.discordUsername);
    return user;
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectMemberDto) {
    return this.usersService.reject(id, dto.reason);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string) {
    return this.usersService.suspend(id);
  }

  @Patch(':id/role')
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.usersService.updateRole(id, dto.role);
  }
}
