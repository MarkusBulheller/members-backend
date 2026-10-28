import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const ATTEMPT_STATUSES = ['FOUND', 'IMPORTED', 'FAILED', 'IGNORED'] as const;

export class ListResultAttemptsQueryDto {
  @IsOptional()
  @IsIn(ATTEMPT_STATUSES)
  status?: (typeof ATTEMPT_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
