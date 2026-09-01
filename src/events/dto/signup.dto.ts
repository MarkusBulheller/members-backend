import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

export class SignupDto {
  /** Undefined = leave unchanged, null = clear, uuid = set — see EventsService.signup(). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  carId?: string | null;

  /** Undefined = leave unchanged, null = clear, string = set — must be one of the event's own
   * carClasses; validated in EventsService.signup() since that needs the event loaded. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  carClass?: string | null;

  /** Optional fallback class — same undefined/null/string semantics as carClass. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  secondaryCarClass?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Which of the event's timeslot options this driver can do — see EventSignup.timeslots. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  timeslotIds?: string[];

  /** Actual wall-clock hours (ISO timestamps, on-the-hour) this driver can take a driving
   * stint — see EventSignup.availableHours for why these are absolute, not offsets. Each must
   * fall within one of the event's timeslot windows; checked in EventsService.signup() since
   * that needs the event's timeslots loaded. Undefined = leave unchanged. */
  @IsOptional()
  @IsArray()
  @IsDateString({}, { each: true })
  availableHours?: string[];
}
