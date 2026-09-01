import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Min, MaxLength, ValidateIf } from 'class-validator';

export class CreateEventTeamDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  carId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  iracingTeamId?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  timeslotId?: string | null;

  /** Time to refuel during a pitstop, in seconds. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  refuelDurationSeconds?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  tyreChangeDurationSeconds?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  pitstopDrivethroughSeconds?: number | null;

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

  /** Minutes of practice + qualifying ahead of the green flag, added on top of the timeslot's own
   * startsAt to get the actual race start. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  raceStartOffsetMinutes?: number | null;

  /** Fuel burned on the formation lap, in liters — deducted from the first stint's usable tank
   * only. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  formationLapFuelLiters?: number | null;

  /** In-game clock time this crew's first stint starts at, "HH:MM" (24h). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'simStartTimeOfDay must be in HH:MM (24h) format' })
  simStartTimeOfDay?: string | null;
}
