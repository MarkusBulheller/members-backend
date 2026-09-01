import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { CAR_CLASSES, type CarClass } from '../car-class.js';

export class CreateCarDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsIn(CAR_CLASSES)
  carClass: CarClass;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tankCapacityLiters: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;
}
