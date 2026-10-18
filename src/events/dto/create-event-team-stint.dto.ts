import { IsBoolean, IsInt, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';

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

  /** Number of tyres changed in the stop before this stint (0-4) — used on LMU events, where the
   * tyre budget is counted per tyre. Wins over `tyreChange` if both are sent; `tyreChange` is
   * stored as `tyresChanged > 0`. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  tyresChanged?: number;

  /** Manual wet/dry override — null (or omitted) leaves it to the weather-forecast auto-detect. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  wetOverride?: boolean | null;
}
