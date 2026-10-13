import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Either a free-text `name` (a placeholder) or a `driverProfileId` (a guest from the Drivers
 * roster — the name is taken from their profile); EventTeamDummyDriversService.create() requires
 * one of the two. */
export class CreateEventTeamDummyDriverDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsUUID()
  driverProfileId?: string;
}
