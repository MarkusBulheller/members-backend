import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTrackDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(60)
  category: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;
}
