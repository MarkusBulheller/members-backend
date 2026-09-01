import { IsIn } from 'class-validator';

export class MoveTeamHighlightDto {
  @IsIn(['up', 'down'])
  direction: 'up' | 'down';
}
