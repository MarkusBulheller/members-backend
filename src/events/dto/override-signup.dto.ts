import { IsEnum } from 'class-validator';
import { SignupStatus } from '../../common/enums/signup-status.enum.js';

export class OverrideSignupDto {
  @IsEnum(SignupStatus)
  status: SignupStatus;
}
