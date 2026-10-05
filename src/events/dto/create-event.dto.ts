import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { EventStatus } from '../../common/enums/event-status.enum.js';

export class CreateEventDto {
  @IsString()
  @MaxLength(150)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsUUID()
  trackId: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  carClasses: string[];

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsDateString()
  signupDeadline?: string;

  /** Minutes — a fixed preset list (mirrored on the frontend, see types/raceLength.ts):
   * 2h40m / 3h / 6h / 8h / 10h / 12h / 24h. */
  @IsIn([160, 180, 360, 480, 600, 720, 1440])
  raceLengthMinutes: number;

  /** Candidate start times (ISO datetimes) — see EventTimeslot. Replaces the whole set on
   * update (see EventsService.update()'s diffing). */
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  timeslots: string[];

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  /** Links this event to a specific iRacing series-season week — undefined leaves the link
   * unchanged (update) / unset (create), null clears it, a number sets it. Both fields are set or
   * cleared together by the client (see event.entity.ts); not cross-validated here. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  iracingSeasonId?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  iracingRaceWeekNum?: number | null;
}
