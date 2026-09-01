import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CONTACT_INQUIRY_INTERESTS } from '../contact-inquiry.entity.js';

export class CreateContactInquiryDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsEmail()
  @MaxLength(200)
  email: string;

  /** Only sent by the form when interestedIn is "Driver Seat" — omitted otherwise, not an empty
   * string. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  iracingId?: string;

  @IsIn(CONTACT_INQUIRY_INTERESTS)
  interestedIn: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
