import { IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';

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
}
