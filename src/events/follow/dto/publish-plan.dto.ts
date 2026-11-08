import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Most stints a plan can hold (a 24h race at short stints is about 40). */
export const MAX_PUBLISHED_STINTS = 200;

export class PublishPlanStintDto {
  @IsUUID()
  id: string;

  @IsISO8601()
  startsAt: string;

  @IsISO8601()
  endsAt: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @Max(1000)
  fuelLiters?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(4)
  tyres?: number | null;
}

export class PublishPlanDto {
  @IsArray()
  @ArrayMaxSize(MAX_PUBLISHED_STINTS)
  @ValidateNested({ each: true })
  @Type(() => PublishPlanStintDto)
  stints: PublishPlanStintDto[];
}
