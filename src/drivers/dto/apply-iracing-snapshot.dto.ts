import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/** The full snapshot for one candidate returned by GET /iracing/drivers/search — submitted
 * as-is to attach/re-pick a manual driver's iRacing identity. */
export class ApplyIracingSnapshotDto {
  @Type(() => Number)
  @IsInt()
  custId: number;

  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sportsCarIrating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sportsCarSafetyRating?: string;
}
