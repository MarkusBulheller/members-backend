import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DISCORD_USERNAME_PATTERN, MAX_SUCCESSIVE_STINTS_CAP, normalizeDiscordUsername } from '../driver.constants.js';

// Intl.supportedValuesOf('timeZone') returns the runtime's IANA tz database — see the identical
// validation in UpdateDriverProfileDto.
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

export class CreateManualDriverDto {
  @IsString()
  @MaxLength(60)
  displayName: string;

  /** Discord username (the handle, e.g. delta2611) — lets the guest sign up through Discord.
   * Normalised (trimmed, "@" stripped, lower-cased) before validation; uniqueness across profiles
   * and portal members is checked in DriversService. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeDiscordUsername(value))
  @Matches(DISCORD_USERNAME_PATTERN, {
    message: 'discordUsername must be a Discord username: 2-32 characters of a-z, 0-9, "_" or "."',
  })
  discordUsername?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  iracingCustId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  iracingName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  iracingLocation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  iracingCountryCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sportsCarIrating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sportsCarSafetyRating?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  preferredClasses?: string;

  @IsOptional()
  @IsIn(VALID_TIMEZONES)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SUCCESSIVE_STINTS_CAP)
  maxSuccessiveStints?: number;

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
