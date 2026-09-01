import { IsIn } from 'class-validator';

export class MoveEventTeamStintDto {
  @IsIn(['up', 'down'])
  direction: 'up' | 'down';
}
