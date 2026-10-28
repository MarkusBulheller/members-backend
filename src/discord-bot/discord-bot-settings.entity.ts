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

  /** Channel that receives race-result messages (new result found / imported). Null = no result
   * messages are posted. Admin-editable like eventsChannelId. */
  @Column({ name: 'results_channel_id', type: 'varchar', nullable: true })
  resultsChannelId: string | null;

  /** Category (a Discord channel of type "category") in which the per-event channels are created
   * from the event page. Null = the feature is off until an admin sets it. */
  @Column({ name: 'event_category_id', type: 'varchar', nullable: true })
  eventCategoryId: string | null;

  /** The Discord application's public key (64 hex chars) — used to verify the Ed25519 signature
   * on every request Discord sends to POST /discord/interactions (button clicks etc.). Not a
   * secret in itself, but stored like the bot token (`select: false`, only reported to the admin
   * page as a boolean) so it's never echoed around. */
  @Column({ name: 'public_key', type: 'varchar', nullable: true, select: false })
  publicKey: string | null;

  /** Discord user id that gets a DM when someone who isn't linked to a driver profile tries to
   * sign up from Discord. Null = nobody is alerted (the clicker is just told to contact an admin). */
  @Column({ name: 'alert_user_id', type: 'varchar', nullable: true })
  alertUserId: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
