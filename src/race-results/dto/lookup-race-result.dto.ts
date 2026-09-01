import { Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

export class LookupRaceResultDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  subsessionId: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  teamId: number;
}
