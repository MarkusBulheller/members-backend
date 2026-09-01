import { IsBoolean } from 'class-validator';

export class UpdateContactInquiryDto {
  @IsBoolean()
  reviewed: boolean;
}
