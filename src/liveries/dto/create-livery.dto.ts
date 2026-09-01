import { IsString, MaxLength } from 'class-validator';

export class CreateLiveryDto {
  @IsString()
  @MaxLength(150)
  name: string;
}
