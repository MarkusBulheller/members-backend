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
  resultsChannelId: string | null;
  /** Category the per-event channels are created in. */
  eventCategoryId: string | null;
  /** Whether an interactions public key is stored — never the key itself. */
  publicKeySet: boolean;
  alertUserId: string | null;
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

  private loadWithSecrets(): Promise<DiscordBotSettings | null> {
    return this.settingsRepository
      .createQueryBuilder('s')
      .addSelect('s.botToken')
      .addSelect('s.publicKey')
      .where('s.id = :id', { id: SETTINGS_ID })
      .getOne();
  }

  /** For the admin settings page — whether a token/public key is set, never their values. */
  async getSettings(): Promise<DiscordBotSettingsView> {
    await this.ensureRow();
    const settings = await this.loadWithSecrets();
    return {
      hasToken: Boolean(settings?.botToken),
      eventsChannelId: settings?.eventsChannelId ?? null,
      resultsChannelId: settings?.resultsChannelId ?? null,
      eventCategoryId: settings?.eventCategoryId ?? null,
      publicKeySet: Boolean(settings?.publicKey),
      alertUserId: settings?.alertUserId ?? null,
    };
  }

  async update(dto: UpdateDiscordBotSettingsDto): Promise<DiscordBotSettingsView> {
    await this.ensureRow();
    const patch: Partial<DiscordBotSettings> = {};
    if (dto.botToken !== undefined && dto.botToken !== '') patch.botToken = dto.botToken;
    if (dto.eventsChannelId !== undefined) patch.eventsChannelId = dto.eventsChannelId || null;
    if (dto.resultsChannelId !== undefined) patch.resultsChannelId = dto.resultsChannelId || null;
    if (dto.eventCategoryId !== undefined) patch.eventCategoryId = dto.eventCategoryId || null;
    if (dto.publicKey !== undefined && dto.publicKey !== '') patch.publicKey = dto.publicKey.toLowerCase();
    if (dto.alertUserId !== undefined) patch.alertUserId = dto.alertUserId || null;
    if (Object.keys(patch).length > 0) {
      await this.settingsRepository.update(SETTINGS_ID, patch);
    }
    return this.getSettings();
  }

  /** For DiscordBotService's own posting call — the one place the raw token is actually needed. */
  async getCredentialsForPosting(): Promise<{ token: string | null; channelId: string | null }> {
    await this.ensureRow();
    const settings = await this.loadWithSecrets();
    return { token: settings?.botToken ?? null, channelId: settings?.eventsChannelId ?? null };
  }

  /** For creating per-event channels: the bot token plus the category they go in. */
  async getEventChannelCredentials(): Promise<{ token: string | null; categoryId: string | null }> {
    await this.ensureRow();
    const settings = await this.loadWithSecrets();
    return { token: settings?.botToken ?? null, categoryId: settings?.eventCategoryId ?? null };
  }

  /** For DiscordBotService.postResultsMessage() — the bot token plus the race-results channel. */
  async getResultsPostingCredentials(): Promise<{ token: string | null; channelId: string | null }> {
    await this.ensureRow();
    const settings = await this.loadWithSecrets();
    return { token: settings?.botToken ?? null, channelId: settings?.resultsChannelId ?? null };
  }

  /** For the interactions endpoint: the stored public key (hex, for the signature check) and the
   * user who receives "unlinked user" alert DMs. */
  async getInteractionConfig(): Promise<{ publicKey: string | null; alertUserId: string | null }> {
    await this.ensureRow();
    const settings = await this.loadWithSecrets();
    return { publicKey: settings?.publicKey ?? null, alertUserId: settings?.alertUserId ?? null };
  }
}
