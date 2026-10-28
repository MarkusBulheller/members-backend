import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { DISCORD_USERNAME_PATTERN, normalizeDiscordUsername } from '../driver.constants.js';

// Intl.supportedValuesOf('timeZone') returns the runtime's IANA tz database — see the identical
// validation in UpdateDriverProfileDto.
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

/** Basic-field editing only — attaching/changing the iRacing identity goes through
 * ApplyIracingSnapshotDto instead, mirroring how applyIracingLink is separate from
 * updateOwnProfile for real members. */
export class UpdateManualDriverDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  /** Discord username (e.g. delta2611); null clears it, omitting leaves it untouched. Normalised
   * (trimmed, "@" stripped, lower-cased) before validation. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(({ value }: { value: unknown }) => normalizeDiscordUsername(value))
  @Matches(DISCORD_USERNAME_PATTERN, {
    message: 'discordUsername must be a Discord username: 2-32 characters of a-z, 0-9, "_" or "."',
  })
  discordUsername?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  preferredClasses?: string;

  /** null explicitly clears a previously-set timezone; omitting the field leaves it untouched —
   * same convention as UpdateDriverProfileDto. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(VALID_TIMEZONES)
  timezone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  maxSuccessiveStints?: number | null;

  @IsOptional()
  @IsBoolean()
  startingDriver?: boolean;

  @IsOptional()
  @IsBoolean()
  wetDriver?: boolean;

  @IsOptional()
  @IsBoolean()
  nightDriver?: boolean;
}
