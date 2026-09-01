import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Singleton row (always id 'singleton', see SETTINGS_ID in discord-bot-settings.service.ts) —
 * admin-editable replacement for the DISCORD_BOT_TOKEN/DISCORD_EVENTS_CHANNEL_ID env vars, so
 * rotating the bot token or changing the announcements channel doesn't need a server redeploy.
 * botToken is `select: false` — like DriverProfile.iracingRefreshToken, it must never come back
 * from a normal query (including anything returned to the frontend); DiscordBotSettingsService
 * explicitly opts back in only where the raw token is actually needed (posting, or the update
 * flow). */
@Entity('discord_bot_settings')
export class DiscordBotSettings {
  @PrimaryColumn()
  id: string;

  @Column({ name: 'bot_token', type: 'varchar', nullable: true, select: false })
  botToken: string | null;

  @Column({ name: 'events_channel_id', type: 'varchar', nullable: true })
  eventsChannelId: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
