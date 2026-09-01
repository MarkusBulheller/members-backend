import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateCarTrackSetupDto {
  @IsUUID()
  trackId: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  fuelPerLapLiters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  pitLaneTimeSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
