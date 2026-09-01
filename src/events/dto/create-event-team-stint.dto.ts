import { IsBoolean, IsNumber, IsOptional, IsUUID, Min, ValidateIf } from 'class-validator';

export class CreateEventTeamStintDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  driverUserId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  durationMinutes?: number | null;

  /** Whether tyres get changed during the pit stop before this stint — ignored for the first
   * stint. Defaults to true (a full tyre change) when omitted on create. */
  @IsOptional()
  @IsBoolean()
  tyreChange?: boolean;

  /** Manual wet/dry override — null (or omitted) leaves it to the weather-forecast auto-detect. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  wetOverride?: boolean | null;
}
