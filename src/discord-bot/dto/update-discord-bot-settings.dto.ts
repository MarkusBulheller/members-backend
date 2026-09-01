import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateDiscordBotSettingsDto {
  /** Blank/omitted leaves the currently-stored token untouched — the frontend never gets the real
   * value back to redisplay, so there's nothing meaningful to submit as "unchanged" otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botToken?: string;

  /** Empty string explicitly clears it (no channel configured, announcements skipped) — distinct
   * from omitting the field, which leaves it untouched. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  eventsChannelId?: string;
}
