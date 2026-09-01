import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateCarDto } from './create-car.dto.js';

export class UpdateCarDto extends PartialType(CreateCarDto) {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
