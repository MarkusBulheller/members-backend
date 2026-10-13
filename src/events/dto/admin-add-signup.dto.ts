import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

/** Admin adds a member to an event (and optionally straight onto a team) without the member
 * having signed up themselves — see EventsService.adminAddSignup(). */
export class AdminAddSignupDto {
  @IsUUID()
  userId: string;

  /** Team to place them on; must belong to the same event. Omitted/null = just sign them up. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  eventTeamId?: string | null;
}
