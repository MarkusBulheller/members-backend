import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { UpdateDiscordBotSettingsDto } from './dto/update-discord-bot-settings.dto.js';
import { DiscordBotSettingsService } from './discord-bot-settings.service.js';
import { DiscordBotStatusService } from './discord-bot-status.service.js';

@Controller('admin/discord-bot-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DiscordBotSettingsController {
  constructor(
    private readonly discordBotSettingsService: DiscordBotSettingsService,
    private readonly discordBotStatusService: DiscordBotStatusService,
  ) {}

  @Get()
  get() {
    return this.discordBotSettingsService.getSettings();
  }

  @Patch()
  update(@Body() dto: UpdateDiscordBotSettingsDto) {
    return this.discordBotSettingsService.update(dto);
  }

  // Live Discord API calls (token validity, guild membership, computed channel permissions) —
  // a separate route rather than folding into GET, since this is meaningfully slower (3-4 real
  // requests to Discord) and shouldn't run every time the settings themselves are just read.
  @Get('status')
  checkStatus() {
    return this.discordBotStatusService.checkStatus();
  }
}
