import { IsArray, IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateEventTeamDummyDriverDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  /** Undefined = leave unchanged; an empty array clears the restriction (free for any stint). */
  @IsOptional()
  @IsArray()
  @IsDateString({}, { each: true })
  availableHours?: string[];
}
