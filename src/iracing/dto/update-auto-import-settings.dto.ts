import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const AUTO_IMPORT_MODES = ['NOTIFY', 'AUTO'] as const;

export class UpdateAutoImportSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(AUTO_IMPORT_MODES)
  mode?: (typeof AUTO_IMPORT_MODES)[number];

  /** Only sessions that ended at least this many minutes ago are considered. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(240)
  delayMinutes?: number;
}
