import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

/** Basic-field editing only — attaching/changing the iRacing identity goes through
 * ApplyIracingSnapshotDto instead, mirroring how applyIracingLink is separate from
 * updateOwnProfile for real members. */
export class UpdateManualDriverDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  preferredClasses?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  maxSuccessiveStints?: number | null;

  @IsOptional()
  @IsBoolean()
  startingDriver?: boolean;

  @IsOptional()
  @IsBoolean()
  wetDriver?: boolean;

  @IsOptional()
  @IsBoolean()
  nightDriver?: boolean;
}
