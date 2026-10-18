import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateTeamHighlightDto {
  @IsString()
  @MaxLength(60)
  period: string;

  @IsString()
  @MaxLength(100)
  title: string;

  @IsString()
  @MaxLength(500)
  description: string;

  /** Finishing position for the dashboard's "P#" badge — omit or send null for none. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  position?: number | null;
}
