import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateManualDriverDto {
  @IsString()
  @MaxLength(60)
  displayName: string;

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
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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
