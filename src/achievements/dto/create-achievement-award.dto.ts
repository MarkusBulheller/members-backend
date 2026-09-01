import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class CreateAchievementAwardDto {
  @IsUUID()
  driverProfileId: string;

  @IsUUID()
  tierId: string;

  @IsOptional()
  @IsUUID()
  eventId?: string;

  /** Defaults to today (see AchievementsService.award()) — an admin backfilling an old award can
   * still override it. */
  @IsOptional()
  @IsDateString()
  achievedAt?: string;
}
