import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UpdateDiscordBotSettingsDto } from './dto/update-discord-bot-settings.dto.js';
import { DiscordBotSettings } from './discord-bot-settings.entity.js';

const SETTINGS_ID = 'singleton';

export interface DiscordBotSettingsView {
  hasToken: boolean;
  eventsChannelId: string | null;
}

@Injectable()
export class DiscordBotSettingsService {
  constructor(
    @InjectRepository(DiscordBotSettings)
    private readonly settingsRepository: Repository<DiscordBotSettings>,
    private readonly configService: ConfigService,
  ) {}

  /** Creates the one settings row on first-ever access, bootstrapped from the DISCORD_BOT_TOKEN/
   * DISCORD_EVENTS_CHANNEL_ID env vars if they're set — so an already-configured bot keeps
   * working the moment this ships, rather than silently going quiet until an admin re-enters the
   * token here. A no-op every time after the first. */
  private async ensureRow(): Promise<void> {
    const exists = await this.settingsRepository.findOne({ where: { id: SETTINGS_ID } });
    if (exists) return;
    await this.settingsRepository.save(
      this.settingsRepository.create({
        id: SETTINGS_ID,
        botToken: this.configService.get<string>('DISCORD_BOT_TOKEN') ?? null,
        eventsChannelId: this.configService.get<string>('DISCORD_EVENTS_CHANNEL_ID') ?? null,
      }),
    );
  }

  /** For the admin settings page — whether a token is set, never the token itself. */
  async getSettings(): Promise<DiscordBotSettingsView> {
    await this.ensureRow();
    const settings = await this.settingsRepository
      .createQueryBuilder('s')
      .addSelect('s.botToken')
      .where('s.id = :id', { id: SETTINGS_ID })
      .getOne();
    return { hasToken: Boolean(settings?.botToken), eventsChannelId: settings?.eventsChannelId ?? null };
  }

  async update(dto: UpdateDiscordBotSettingsDto): Promise<DiscordBotSettingsView> {
    await this.ensureRow();
    const patch: Partial<DiscordBotSettings> = {};
    if (dto.botToken !== undefined && dto.botToken !== '') patch.botToken = dto.botToken;
    if (dto.eventsChannelId !== undefined) patch.eventsChannelId = dto.eventsChannelId || null;
    if (Object.keys(patch).length > 0) {
      await this.settingsRepository.update(SETTINGS_ID, patch);
    }
    return this.getSettings();
  }

  /** For DiscordBotService's own posting call — the one place the raw token is actually needed. */
  async getCredentialsForPosting(): Promise<{ token: string | null; channelId: string | null }> {
    await this.ensureRow();
    const settings = await this.settingsRepository
      .createQueryBuilder('s')
      .addSelect('s.botToken')
      .where('s.id = :id', { id: SETTINGS_ID })
      .getOne();
    return { token: settings?.botToken ?? null, channelId: settings?.eventsChannelId ?? null };
  }
}
