import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateIracingTeamDto {
  /** false hides the team from the default team list/pickers and turns its auto-import off. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Watch this team for new race results. Rejected for an inactive team. */
  @IsOptional()
  @IsBoolean()
  autoImport?: boolean;

  /** Rename — only allowed for a team that was added by hand (synced names come from iRacing). */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(100)
  teamName?: string;
}

export class CreateIracingTeamDto {
  /** iRacing's team id; the sign is ignored (race results use the negative form, we store the
   * positive one). */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'number' ? Math.abs(value) : value))
  @IsInt()
  @Min(1)
  teamId: number;

  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(100)
  teamName: string;
}
