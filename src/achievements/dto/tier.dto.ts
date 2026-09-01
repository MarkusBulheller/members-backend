import { IsInt, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

/** Shared shape for a tier inside create/update-definition payloads. `id` is present only when
 * updating an existing tier (see AchievementsService.syncTiers, which mirrors
 * EventsService.syncTimeslots' match-existing/add-new/remove-dropped approach). `threshold` is
 * validated against the parent definition's metric in the service, not here. */
export class TierDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MaxLength(60)
  label: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  threshold?: number;
}
