import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateCarTrackSetupDto } from './create-car-track-setup.dto.js';

export class UpdateCarTrackSetupDto extends PartialType(
  OmitType(CreateCarTrackSetupDto, ['trackId'] as const),
) {}
