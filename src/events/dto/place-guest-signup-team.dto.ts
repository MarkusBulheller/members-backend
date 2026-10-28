import { IsUUID } from 'class-validator';

export class PlaceGuestSignupTeamDto {
  /** The event team to put the guest on (must belong to the same event). */
  @IsUUID()
  eventTeamId: string;
}
