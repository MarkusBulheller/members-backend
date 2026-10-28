import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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

  /** Channel for race-result messages (a Discord snowflake). Empty string clears it (no result
   * messages); omitted leaves it untouched. */
  @IsOptional()
  @IsString()
  @Matches(/^(\d{15,25})?$/, { message: 'resultsChannelId must be a Discord channel ID (15-25 digits)' })
  resultsChannelId?: string;

  /** Discord application public key — 64 hex chars (a 32-byte Ed25519 key). Blank/omitted leaves
   * the stored key untouched, same as botToken. */
  @IsOptional()
  @IsString()
  @Matches(/^([0-9a-fA-F]{64})?$/, { message: 'publicKey must be 64 hexadecimal characters' })
  publicKey?: string;

  /** Discord user id (snowflake) alerted about unlinked sign-up attempts. Empty string clears it;
   * omitted leaves it untouched. */
  @IsOptional()
  @IsString()
  @Matches(/^(\d{15,25})?$/, { message: 'alertUserId must be a Discord user ID (15-25 digits)' })
  alertUserId?: string;
}
