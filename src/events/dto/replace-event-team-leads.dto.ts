import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class ReplaceEventTeamLeadsDto {
  /** The complete set of leads for this event crew (approved drivers placed on the crew); `[]` clears it. */
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  userIds: string[];
}
