import { IsBoolean, IsOptional } from 'class-validator';

export class StartStintNowDto {
  /** true = (re)start this stint at the current moment even if it already has a recorded start,
   * instead of toggling that start off. For the stint that is running right now. */
  @IsOptional()
  @IsBoolean()
  restart?: boolean;
}
