import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectMemberDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
