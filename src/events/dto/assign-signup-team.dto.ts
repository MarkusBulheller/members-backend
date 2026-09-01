import { IsUUID, ValidateIf } from 'class-validator';

export class AssignSignupTeamDto {
  /** null clears the assignment back to "unassigned"; a uuid assigns to that team (must belong
   * to the same event — checked in EventsService.assignSignupTeam()). */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  eventTeamId: string | null;
}
