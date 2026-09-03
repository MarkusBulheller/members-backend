import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

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
