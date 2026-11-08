import { IsString, MaxLength, MinLength } from 'class-validator';

export class PostRaceReportDto {
  /** The report text as edited, Discord markdown (max 2000 characters). */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}
