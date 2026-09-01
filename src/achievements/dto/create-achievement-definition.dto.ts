import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AchievementIcon } from '../../common/enums/achievement-icon.enum.js';
import { AchievementMetric } from '../../common/enums/achievement-metric.enum.js';
import { TierDto } from './tier.dto.js';

export class CreateAchievementDefinitionDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsEnum(AchievementMetric)
  metric: AchievementMetric;

  @IsOptional()
  @IsEnum(AchievementIcon)
  icon?: AchievementIcon;

  /** Required when metric is TRACK_WIN; ignored (and rejected) for every other metric — checked
   * in AchievementsService since that's cross-field. */
  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers: TierDto[];
}
