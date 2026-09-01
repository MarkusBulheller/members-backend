import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateTrackDto } from './create-track.dto.js';

export class UpdateTrackDto extends PartialType(CreateTrackDto) {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
