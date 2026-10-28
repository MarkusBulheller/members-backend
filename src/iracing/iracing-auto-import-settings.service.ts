import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordBotSettingsService } from '../discord-bot/discord-bot-settings.service.js';
import { UpdateAutoImportSettingsDto } from './dto/update-auto-import-settings.dto.js';
import {
  AutoImportMode,
  AutoImportRunStatus,
  IracingAutoImportSettings,
} from './iracing-auto-import-settings.entity.js';

export const AUTO_IMPORT_SETTINGS_ID = 1;

/** What GET/PATCH /iracing/auto-import return. */
export interface AutoImportSettingsView {
  enabled: boolean;
  mode: AutoImportMode;
  delayMinutes: number;
  /** Read from the Discord bot settings (Admin → Discord Bot), not stored here. */
  resultsChannelId: string | null;
  lastRunAt: Date | null;
  lastRunStatus: AutoImportRunStatus | null;
  lastRunMessage: string | null;
  enabledSince: Date | null;
}

@Injectable()
export class IracingAutoImportSettingsService {
  constructor(
    @InjectRepository(IracingAutoImportSettings)
    private readonly settingsRepository: Repository<IracingAutoImportSettings>,
    private readonly discordBotSettingsService: DiscordBotSettingsService,
  ) {}

  /** The singleton row, created with the defaults (off, NOTIFY, 20 min) on first access. */
  async getRow(): Promise<IracingAutoImportSettings> {
    const existing = await this.settingsRepository.findOne({ where: { id: AUTO_IMPORT_SETTINGS_ID } });
    if (existing) return existing;
    return this.settingsRepository.save(
      this.settingsRepository.create({
        id: AUTO_IMPORT_SETTINGS_ID,
        enabled: false,
        mode: 'NOTIFY',
        delayMinutes: 20,
        enabledSince: null,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunMessage: null,
      }),
    );
  }

  async getView(): Promise<AutoImportSettingsView> {
    return this.toView(await this.getRow());
  }

  /** Switching `enabled` from false to true stamps `enabledSince` = now: only results that finish
   * after that moment are ever picked up (no backfill). */
  async update(dto: UpdateAutoImportSettingsDto): Promise<AutoImportSettingsView> {
    const row = await this.getRow();
    const patch: Partial<IracingAutoImportSettings> = {};
    if (dto.enabled !== undefined) {
      patch.enabled = dto.enabled;
      if (dto.enabled && !row.enabled) patch.enabledSince = new Date();
    }
    if (dto.mode !== undefined) patch.mode = dto.mode;
    if (dto.delayMinutes !== undefined) patch.delayMinutes = dto.delayMinutes;
    if (Object.keys(patch).length > 0) {
      await this.settingsRepository.update(AUTO_IMPORT_SETTINGS_ID, patch);
    }
    return this.getView();
  }

  async recordRun(status: AutoImportRunStatus, message: string): Promise<void> {
    await this.getRow();
    await this.settingsRepository.update(AUTO_IMPORT_SETTINGS_ID, {
      lastRunAt: new Date(),
      lastRunStatus: status,
      lastRunMessage: message.slice(0, 2000),
    });
  }

  private async toView(row: IracingAutoImportSettings): Promise<AutoImportSettingsView> {
    const discord = await this.discordBotSettingsService.getSettings();
    return {
      enabled: row.enabled,
      mode: row.mode,
      delayMinutes: row.delayMinutes,
      resultsChannelId: discord.resultsChannelId,
      lastRunAt: row.lastRunAt,
      lastRunStatus: row.lastRunStatus,
      lastRunMessage: row.lastRunMessage,
      enabledSince: row.enabledSince,
    };
  }
}
