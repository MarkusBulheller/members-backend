import { IsInt, Max, Min } from 'class-validator';

/** Where a dragged stint should land: its new 0-based position in the team's stint list. */
export class MoveEventTeamStintToDto {
  @IsInt()
  @Min(0)
  @Max(500)
  index: number;
}
