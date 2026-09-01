import { IsString, MaxLength } from 'class-validator';

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
}
