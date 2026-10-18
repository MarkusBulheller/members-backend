import { Transform, Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

export class LookupRaceResultDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  subsessionId: number;

  // iRacing represents a team with a negative id in some places (team entries in results use
  // -teamId, and the synced team list can carry the negative form), so accept either sign and
  // work with the positive id everywhere downstream.
  @Type(() => Number)
  @Transform(({ value }: { value: unknown }) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.abs(n) : value;
  })
  @IsInt()
  @IsPositive()
  teamId: number;
}
