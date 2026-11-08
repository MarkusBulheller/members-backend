import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsUUID, ValidateNested } from 'class-validator';

/** Most stints a plan can hold (a 24h race at short stints is about 40). */
export const MAX_BASELINE_STINTS = 200;

export class PlanBaselineStintDto {
  @IsUUID()
  id: string;

  @IsISO8601()
  startsAt: string;

  @IsISO8601()
  endsAt: string;
}

export class SetPlanBaselineDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BASELINE_STINTS)
  @ValidateNested({ each: true })
  @Type(() => PlanBaselineStintDto)
  stints: PlanBaselineStintDto[];

  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  source?: 'AUTO' | 'MANUAL';
}
