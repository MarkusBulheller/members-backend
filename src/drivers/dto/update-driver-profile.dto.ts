import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

// Intl.supportedValuesOf('timeZone') returns the runtime's IANA tz database — validating against
// it directly (rather than a hand-maintained list) means it can never drift out of date.
const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

export class UpdateDriverProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  iracingCustomerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  /** string | null (not just optional) — null explicitly clears a previously-set timezone; simply
   * omitting the field leaves whatever's already stored untouched. */
  @IsOptional()
  @IsIn(VALID_TIMEZONES)
  timezone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  preferredClasses?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  /** null explicitly clears a previously-set value, same convention as timezone above. */
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
