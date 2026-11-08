import { IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class UpsertEventTeamDriverSettingsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  lapTimeDrySeconds?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  lapTimeWetSeconds?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  fuelUsagePerLapLiters?: number | null;

  /** Overrides the team's planned fuel saving for this driver (0-50 percent); null follows the team. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @Max(50)
  fuelSavePercent?: number | null;
}
